/**
 * @module @breeze/transit-service/adapters/circuit-breaker
 * Three-state circuit breaker: CLOSED → OPEN → HALF_OPEN.
 *
 * State transitions:
 *   CLOSED → OPEN:      5 consecutive failures within 60s window
 *   OPEN → HALF_OPEN:   after 60s recovery timeout
 *   HALF_OPEN → CLOSED: test request succeeds
 *   HALF_OPEN → OPEN:   test request fails
 *
 * Health score: successes / total calls in a sliding 5-minute window.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CallRecord {
  timestamp: number;
  success: boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private lastStateChange = Date.now();

  /** Sliding window of call records for health score (5 minutes). */
  private readonly callHistory: CallRecord[] = [];

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly recoveryTimeoutMs: number;
  private readonly healthWindowMs: number;

  constructor(
    private readonly name: string,
    options?: {
      failureThreshold?: number;
      failureWindowMs?: number;
      recoveryTimeoutMs?: number;
      healthWindowMs?: number;
    },
  ) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.failureWindowMs = options?.failureWindowMs ?? 60_000;
    this.recoveryTimeoutMs = options?.recoveryTimeoutMs ?? 60_000;
    this.healthWindowMs = options?.healthWindowMs ?? 300_000; // 5 minutes
  }

  /**
   * Execute a function through the circuit breaker.
   * When OPEN: throws immediately (fail fast, zero network calls).
   * When HALF_OPEN: allows one test request through.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // ── OPEN state: fail fast ────────────────────────────
    if (this.state === 'OPEN') {
      // Check if recovery timeout has elapsed
      if (Date.now() - this.lastStateChange >= this.recoveryTimeoutMs) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitOpenError(
          `Circuit breaker '${this.name}' is OPEN. Failing fast.`,
        );
      }
    }

    // ── Execute the function ─────────────────────────────
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordSuccess(): void {
    this.callHistory.push({ timestamp: Date.now(), success: true });
    this.pruneHistory();

    this.consecutiveFailures = 0;

    if (this.state === 'HALF_OPEN') {
      // Test request succeeded → close circuit
      this.transitionTo('CLOSED');
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    this.callHistory.push({ timestamp: now, success: false });
    this.pruneHistory();

    this.lastFailureTime = now;

    if (this.state === 'HALF_OPEN') {
      // Test request failed → reopen circuit
      this.transitionTo('OPEN');
      return;
    }

    // Count consecutive failures within the failure window
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.failureThreshold) {
      const windowStart = now - this.failureWindowMs;
      if (this.lastFailureTime >= windowStart) {
        this.transitionTo('OPEN');
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const prev = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState === 'CLOSED') {
      this.consecutiveFailures = 0;
    }

    console.log(
      `CircuitBreaker[${this.name}]: ${prev} → ${newState}`,
    );
  }

  private pruneHistory(): void {
    const cutoff = Date.now() - this.healthWindowMs;
    while (this.callHistory.length > 0 && this.callHistory[0]!.timestamp < cutoff) {
      this.callHistory.shift();
    }
  }

  /**
   * Health score: proportion of successful calls in the last 5 minutes.
   * Returns 1.0 if no calls have been made (optimistic default).
   */
  getHealthScore(): number {
    this.pruneHistory();
    if (this.callHistory.length === 0) return 1.0;

    const successes = this.callHistory.filter((r) => r.success).length;
    return successes / this.callHistory.length;
  }

  getState(): CircuitState {
    // Check for automatic OPEN → HALF_OPEN transition
    if (
      this.state === 'OPEN' &&
      Date.now() - this.lastStateChange >= this.recoveryTimeoutMs
    ) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  getName(): string {
    return this.name;
  }
}

/** Error thrown when circuit is OPEN — zero latency, zero network calls. */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
