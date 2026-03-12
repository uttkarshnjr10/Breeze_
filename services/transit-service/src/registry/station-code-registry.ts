/**
 * @module @breeze/transit-service/registry
 * StationCodeRegistry — bidirectional lookup between internal Breeze node IDs
 * and external codes (IRCTC, IATA, Google Place ID, Amadeus).
 *
 * Loaded from station_code_mappings table on startup. Singleton.
 */

import type { Pool } from 'pg';
import { CodeSystem } from '../models/types.js';

export class StationCodeRegistry {
  /**
   * external → internal lookup:
   * Map<`${codeSystem}:${externalCode}`, internalId>
   */
  private readonly externalToInternal = new Map<string, string>();

  /**
   * internal → external lookup:
   * Map<`${internalId}:${codeSystem}`, externalCode>
   */
  private readonly internalToExternal = new Map<string, string>();

  private loaded = false;

  /** Load all mappings from the database. Call once on startup. */
  async initialize(pool: Pool): Promise<void> {
    const { rows } = await pool.query<{
      internal_id: string;
      code_system: string;
      external_code: string;
    }>('SELECT internal_id, code_system, external_code FROM station_code_mappings');

    for (const row of rows) {
      const extKey = `${row.code_system}:${row.external_code}`;
      const intKey = `${row.internal_id}:${row.code_system}`;

      this.externalToInternal.set(extKey, row.internal_id);
      this.internalToExternal.set(intKey, row.external_code);
    }

    this.loaded = true;
    console.log(`StationCodeRegistry: loaded ${rows.length} mappings`);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get mappingCount(): number {
    return this.externalToInternal.size;
  }

  /**
   * Resolve an external code to an internal Breeze node ID.
   * Returns null if the code is not in the registry.
   */
  resolve(code: string, system: CodeSystem): string | null {
    if (system === CodeSystem.INTERNAL) {
      return code; // Already an internal ID
    }
    return this.externalToInternal.get(`${system}:${code}`) ?? null;
  }

  /**
   * Get the external code for a given internal ID and code system.
   * Returns null if no mapping exists.
   */
  getExternalCode(internalId: string, system: CodeSystem): string | null {
    return this.internalToExternal.get(`${internalId}:${system}`) ?? null;
  }
}
