/**
 * @module @breeze/transit-service/monitor
 * NTESMonitor — polls live train running status with adaptive frequency.
 *
 * Priority queue in Redis sorted set (survives restarts).
 * CRITICAL trains polled every 60s, INACTIVE every 30min.
 * Emits Kafka events: train.delay.detected, train.delay.recovered.
 * Writes to TimescaleDB train_status_history on every poll.
 */

import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Producer } from 'kafkajs';
import { RailwayApiAdapter } from '../adapters/railway-api.adapter.js';
import {
  RiskLevel,
  RISK_POLL_INTERVALS,
  type MonitoredTrain,
} from '../models/types.js';

const POLL_QUEUE_KEY = 'ntes:poll-queue';
const TRAIN_DATA_PREFIX = 'ntes:train-data:';

const DELAY_EMIT_THRESHOLD = 10;  // minutes
const DELAY_CHANGE_THRESHOLD = 5; // minutes change to re-emit
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export class NTESMonitor {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly railwayAdapter: RailwayApiAdapter,
    private readonly redis: Redis,
    private readonly pool: Pool,
    private readonly kafkaProducer: Producer,
  ) {}

  /**
   * Start the adaptive polling loop.
   * On startup: restore queue from Redis or rebuild from active trips.
   */
  async start(): Promise<void> {
    this.running = true;

    // Restore or rebuild the poll queue
    const queueSize = await this.redis.zcard(POLL_QUEUE_KEY);
    if (queueSize === 0) {
      await this.rebuildQueueFromActiveTrips();
    }

    console.log(`NTESMonitor: started. Queue size: ${await this.redis.zcard(POLL_QUEUE_KEY)}`);

    // Start polling loop
    this.schedulePoll();

    // Start cleanup job (every 15 minutes)
    this.cleanupTimer = setInterval(() => {
      this.cleanupCompletedTrips().catch((err) =>
        console.error('NTESMonitor: cleanup failed:', err),
      );
    }, CLEANUP_INTERVAL_MS);
  }

  /** Graceful stop. */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    console.log('NTESMonitor: stopped');
  }

  /**
   * Add a train to the monitoring queue.
   * Called when 'trip.created' Kafka event arrives.
   */
  async addTrain(
    trainNumber: string,
    tripId: string,
    departureTime: Date,
    connectionWindowMinutes: number,
  ): Promise<void> {
    const riskLevel = this.computeRiskLevel(departureTime, 0, connectionWindowMinutes);
    const nextPoll = Date.now() + RISK_POLL_INTERVALS[riskLevel];

    const trainData: MonitoredTrain = {
      trainNumber,
      tripIds: [tripId],
      riskLevel,
      nextPollTime: nextPoll,
      lastDelayMinutes: 0,
      lastEmittedDelay: 0,
    };

    // Check if train already monitored (add trip to existing)
    const existing = await this.redis.get(`${TRAIN_DATA_PREFIX}${trainNumber}`);
    if (existing) {
      const parsed = JSON.parse(existing) as MonitoredTrain;
      if (!parsed.tripIds.includes(tripId)) {
        parsed.tripIds.push(tripId);
      }
      // Recalculate risk (might be higher now with more trips)
      parsed.riskLevel = this.pickHighestRisk(parsed.riskLevel, riskLevel);
      await this.redis.set(
        `${TRAIN_DATA_PREFIX}${trainNumber}`,
        JSON.stringify(parsed),
      );
      return;
    }

    await this.redis.set(
      `${TRAIN_DATA_PREFIX}${trainNumber}`,
      JSON.stringify(trainData),
    );
    await this.redis.zadd(POLL_QUEUE_KEY, nextPoll, trainNumber);
  }

  /**
   * Remove a train from monitoring (trip completed/cancelled).
   */
  async removeTrain(trainNumber: string, tripId: string): Promise<void> {
    const raw = await this.redis.get(`${TRAIN_DATA_PREFIX}${trainNumber}`);
    if (!raw) return;

    const data = JSON.parse(raw) as MonitoredTrain;
    data.tripIds = data.tripIds.filter((id) => id !== tripId);

    if (data.tripIds.length === 0) {
      await this.redis.zrem(POLL_QUEUE_KEY, trainNumber);
      await this.redis.del(`${TRAIN_DATA_PREFIX}${trainNumber}`);
    } else {
      await this.redis.set(`${TRAIN_DATA_PREFIX}${trainNumber}`, JSON.stringify(data));
    }
  }

  // ── Poll Loop ──────────────────────────────────────────────

  private schedulePoll(): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollDueTrains();
      } catch (err) {
        console.error('NTESMonitor: poll error:', err);
      }
      this.schedulePoll(); // Reschedule
    }, 5_000); // Check every 5 seconds for due trains
  }

  private async pollDueTrains(): Promise<void> {
    const now = Date.now();

    // Pop trains whose next_poll_time <= now
    const dueTrains = await this.redis.zrangebyscore(
      POLL_QUEUE_KEY, 0, now, 'LIMIT', 0, 10,
    );

    for (const trainNumber of dueTrains) {
      const raw = await this.redis.get(`${TRAIN_DATA_PREFIX}${trainNumber}`);
      if (!raw) {
        await this.redis.zrem(POLL_QUEUE_KEY, trainNumber);
        continue;
      }

      const trainData = JSON.parse(raw) as MonitoredTrain;

      try {
        await this.pollSingleTrain(trainNumber, trainData);
      } catch (err) {
        console.warn(`NTESMonitor: poll failed for ${trainNumber}:`, err);
      }
    }
  }

  private async pollSingleTrain(
    trainNumber: string,
    trainData: MonitoredTrain,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // Fetch live status
    let delayMinutes = 0;
    let currentStation = '';

    try {
      const status = await this.railwayAdapter.getLiveStatus(trainNumber, today);
      const data = status.data as Record<string, unknown>;

      delayMinutes = Math.max(0, Number(data.delay_minutes ?? data.late_mins ?? 0));
      currentStation = String(data.current_station ?? data.curr_stn ?? '');
    } catch {
      // If poll fails, keep previous delay value
      delayMinutes = trainData.lastDelayMinutes;
    }

    // ── Write to TimescaleDB ─────────────────────────────
    try {
      // Compute rolling on-time performance (EMA with 0.95 decay)
      const prevResult = await this.pool.query(
        `SELECT on_time_performance FROM train_status_history 
         WHERE train_number = $1 ORDER BY time DESC LIMIT 1`,
        [trainNumber],
      );
      const prevAvg = prevResult.rows[0]?.on_time_performance ?? 0;
      const newAvg = prevAvg * 0.95 + delayMinutes * 0.05;

      await this.pool.query(
        `INSERT INTO train_status_history (time, train_number, current_station, delay_minutes, on_time_performance)
         VALUES (NOW(), $1, $2, $3, $4)`,
        [trainNumber, currentStation, delayMinutes, newAvg],
      );
    } catch (err) {
      console.warn(`NTESMonitor: TimescaleDB write failed for ${trainNumber}:`, err);
    }

    // ── Delay event logic ────────────────────────────────
    const previousDelay = trainData.lastEmittedDelay;

    if (
      delayMinutes >= DELAY_EMIT_THRESHOLD &&
      Math.abs(delayMinutes - previousDelay) >= DELAY_CHANGE_THRESHOLD
    ) {
      // Emit train.delay.detected
      await this.emitDelayEvent(trainNumber, delayMinutes, previousDelay, trainData.tripIds);
      trainData.lastEmittedDelay = delayMinutes;
    } else if (previousDelay >= DELAY_EMIT_THRESHOLD && delayMinutes < 5) {
      // Recovery detected
      await this.emitRecoveryEvent(trainNumber, previousDelay, trainData.tripIds);
      trainData.lastEmittedDelay = 0;
    }

    // ── Update risk level and reschedule ─────────────────
    trainData.lastDelayMinutes = delayMinutes;
    const newRisk = this.computeRiskLevel(
      new Date(), // simplified — would use actual departure time
      delayMinutes,
      90, // default connection window
    );
    trainData.riskLevel = newRisk;
    trainData.nextPollTime = Date.now() + RISK_POLL_INTERVALS[newRisk];

    await this.redis.set(`${TRAIN_DATA_PREFIX}${trainNumber}`, JSON.stringify(trainData));
    await this.redis.zadd(POLL_QUEUE_KEY, trainData.nextPollTime, trainNumber);
  }

  // ── Kafka Events ───────────────────────────────────────────

  private async emitDelayEvent(
    trainNumber: string,
    delayMinutes: number,
    previousDelay: number,
    tripIds: string[],
  ): Promise<void> {
    await this.kafkaProducer.send({
      topic: 'breeze.train.delay.detected',
      messages: [
        {
          key: trainNumber,
          value: JSON.stringify({
            external_id: trainNumber,
            delay_minutes: delayMinutes,
            previous_delay_minutes: previousDelay,
            affected_trip_ids: tripIds,
            reported_at: new Date().toISOString(),
          }),
          headers: {
            'x-trace-id': `ntes-${trainNumber}-${Date.now()}`,
            'x-produced-at': new Date().toISOString(),
          },
        },
      ],
    });

    console.warn(
      `NTESMonitor: DELAY DETECTED — ${trainNumber} delayed ${delayMinutes}min (prev: ${previousDelay}min), affects ${tripIds.length} trips`,
    );
  }

  private async emitRecoveryEvent(
    trainNumber: string,
    previousDelay: number,
    tripIds: string[],
  ): Promise<void> {
    await this.kafkaProducer.send({
      topic: 'breeze.train.delay.recovered',
      messages: [
        {
          key: trainNumber,
          value: JSON.stringify({
            external_id: trainNumber,
            previous_delay_minutes: previousDelay,
            affected_trip_ids: tripIds,
            recovered_at: new Date().toISOString(),
          }),
          headers: {
            'x-trace-id': `ntes-recovery-${trainNumber}-${Date.now()}`,
          },
        },
      ],
    });

    console.log(`NTESMonitor: RECOVERY — ${trainNumber} back on time (was ${previousDelay}min late)`);
  }

  // ── Risk Level Computation ─────────────────────────────────

  private computeRiskLevel(
    departureTime: Date,
    delayMinutes: number,
    connectionWindowMinutes: number,
  ): RiskLevel {
    // CRITICAL: tight connection window
    if (connectionWindowMinutes < 90) return RiskLevel.CRITICAL;

    // HIGH: already delayed significantly
    if (delayMinutes > 15) return RiskLevel.HIGH;

    const hoursUntilDeparture = (departureTime.getTime() - Date.now()) / 3_600_000;

    if (hoursUntilDeparture <= 6) return RiskLevel.MEDIUM;
    if (hoursUntilDeparture <= 24) return RiskLevel.LOW;
    return RiskLevel.INACTIVE;
  }

  private pickHighestRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
    const order: Record<RiskLevel, number> = {
      [RiskLevel.CRITICAL]: 4,
      [RiskLevel.HIGH]: 3,
      [RiskLevel.MEDIUM]: 2,
      [RiskLevel.LOW]: 1,
      [RiskLevel.INACTIVE]: 0,
    };
    return order[a] >= order[b] ? a : b;
  }

  // ── Queue Management ───────────────────────────────────────

  private async rebuildQueueFromActiveTrips(): Promise<void> {
    try {
      const { rows } = await this.pool.query(`
        SELECT DISTINCT ts.external_id AS train_number, t.id AS trip_id
        FROM trip_segments ts
        JOIN trips t ON t.id = ts.trip_id
        WHERE ts.transport_mode = 'TRAIN'
          AND t.status IN ('PLANNED', 'ACTIVE')
          AND ts.external_id IS NOT NULL
      `);

      for (const row of rows) {
        await this.addTrain(
          row.train_number,
          String(row.trip_id),
          new Date(), // simplified
          90,
        );
      }

      console.log(`NTESMonitor: rebuilt queue from ${rows.length} active trip segments`);
    } catch (err) {
      console.warn('NTESMonitor: failed to rebuild queue from active trips:', err);
    }
  }

  private async cleanupCompletedTrips(): Promise<void> {
    const allTrains = await this.redis.zrange(POLL_QUEUE_KEY, 0, -1);

    for (const trainNumber of allTrains) {
      const raw = await this.redis.get(`${TRAIN_DATA_PREFIX}${trainNumber}`);
      if (!raw) {
        await this.redis.zrem(POLL_QUEUE_KEY, trainNumber);
        continue;
      }

      const data = JSON.parse(raw) as MonitoredTrain;

      // Verify trips are still active
      const { rows } = await this.pool.query(
        `SELECT id FROM trips WHERE id = ANY($1) AND status IN ('PLANNED', 'ACTIVE')`,
        [data.tripIds],
      );

      const activeTripIds = rows.map((r) => String(r.id));
      data.tripIds = data.tripIds.filter((id) => activeTripIds.includes(id));

      if (data.tripIds.length === 0) {
        await this.redis.zrem(POLL_QUEUE_KEY, trainNumber);
        await this.redis.del(`${TRAIN_DATA_PREFIX}${trainNumber}`);
      } else {
        await this.redis.set(`${TRAIN_DATA_PREFIX}${trainNumber}`, JSON.stringify(data));
      }
    }
  }
}
