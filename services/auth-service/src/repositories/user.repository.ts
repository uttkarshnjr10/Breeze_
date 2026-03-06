/**
 * @module @breeze/auth-service/repositories
 * UserRepository — data access layer for users and emergency contacts.
 * All queries are parameterized. Writes use transactions where needed.
 * Connects to PostgreSQL via PgBouncer (port 6432).
 */

import { Pool, type PoolClient } from 'pg';

// ─── Domain Types ──────────────────────────────────────────────

/** Database row shape for the `users` table. */
export interface User {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly avatarUrl: string | null;
    readonly roles: string[];
    readonly isVerifiedTraveler: boolean;
    readonly verifiedTravelerTicketUrl: string | null;
    readonly lastLoginAt: Date;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Database row shape for the `emergency_contacts` table. */
export interface EmergencyContact {
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly phone: string;
    readonly relation: string;
    readonly createdAt: Date;
}

/** Input for upserting a user from Firebase auth data. */
export interface FirebaseUserInput {
    readonly firebaseUid: string;
    readonly email: string;
    readonly displayName: string;
    readonly avatarUrl?: string | undefined;
}

/** Input for updating a user profile. */
export interface UpdateProfileInput {
    readonly displayName?: string | undefined;
    readonly avatarUrl?: string | undefined;
}

/** Input for creating an emergency contact. */
export interface EmergencyContactInput {
    readonly name: string;
    readonly phone: string;
    readonly relation: string;
}

// ─── Row Mapping ───────────────────────────────────────────────

/**
 * Maps a raw PostgreSQL row to a typed User object.
 * firebase_uid is intentionally excluded — it must never appear in HTTP responses.
 * @param row - Raw database row.
 * @returns Typed User object.
 */
function mapRowToUser(row: Record<string, unknown>): User {
    return {
        id: row['id'] as string,
        email: row['email'] as string,
        displayName: row['display_name'] as string,
        avatarUrl: (row['avatar_url'] as string | null) ?? null,
        roles: row['roles'] as string[],
        isVerifiedTraveler: row['is_verified_traveler'] as boolean,
        verifiedTravelerTicketUrl: (row['verified_traveler_ticket_url'] as string | null) ?? null,
        lastLoginAt: row['last_login_at'] as Date,
        createdAt: row['created_at'] as Date,
        updatedAt: row['updated_at'] as Date,
    };
}

/**
 * Maps a raw PostgreSQL row to a typed EmergencyContact object.
 * @param row - Raw database row.
 * @returns Typed EmergencyContact object.
 */
function mapRowToEmergencyContact(row: Record<string, unknown>): EmergencyContact {
    return {
        id: row['id'] as string,
        userId: row['user_id'] as string,
        name: row['name'] as string,
        phone: row['phone'] as string,
        relation: row['relation'] as string,
        createdAt: row['created_at'] as Date,
    };
}

// ─── Repository ────────────────────────────────────────────────

/**
 * Data access layer for users and emergency contacts.
 * Uses pg.Pool connected to PostgreSQL via PgBouncer.
 */
export class UserRepository {
    private readonly pool: Pool;

    /**
     * @param pool - pg.Pool instance connected via PgBouncer (port 6432).
     */
    constructor(pool: Pool) {
        this.pool = pool;
    }

    /**
     * Finds a user by their Firebase UID.
     * @param uid - Firebase UID.
     * @returns The user, or null if not found.
     */
    async findByFirebaseUid(uid: string): Promise<User | null> {
        const result = await this.pool.query(
            `SELECT id, email, display_name, avatar_url, roles,
              is_verified_traveler, verified_traveler_ticket_url,
              last_login_at, created_at, updated_at
       FROM users WHERE firebase_uid = $1`,
            [uid],
        );

        if (result.rows.length === 0) {
            return null;
        }

        return mapRowToUser(result.rows[0] as Record<string, unknown>);
    }

    /**
     * Finds a user by their PostgreSQL UUID.
     * @param id - PostgreSQL UUID.
     * @returns The user, or null if not found.
     */
    async findById(id: string): Promise<User | null> {
        const result = await this.pool.query(
            `SELECT id, email, display_name, avatar_url, roles,
              is_verified_traveler, verified_traveler_ticket_url,
              last_login_at, created_at, updated_at
       FROM users WHERE id = $1`,
            [id],
        );

        if (result.rows.length === 0) {
            return null;
        }

        return mapRowToUser(result.rows[0] as Record<string, unknown>);
    }

    /**
     * Atomically upserts a user from Firebase authentication data.
     * Uses INSERT ... ON CONFLICT (firebase_uid) DO UPDATE — single SQL statement.
     * On conflict, updates last_login_at and updated_at.
     *
     * @param input - Firebase user data (uid, email, display name, avatar).
     * @returns The upserted User.
     */
    async upsertFromFirebase(input: FirebaseUserInput): Promise<User> {
        const result = await this.pool.query(
            `INSERT INTO users (firebase_uid, email, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         last_login_at = NOW(),
         updated_at = NOW()
       RETURNING id, email, display_name, avatar_url, roles,
                 is_verified_traveler, verified_traveler_ticket_url,
                 last_login_at, created_at, updated_at`,
            [input.firebaseUid, input.email, input.displayName, input.avatarUrl ?? null],
        );

        return mapRowToUser(result.rows[0] as Record<string, unknown>);
    }

    /**
     * Updates a user's profile fields.
     * Only provided fields are updated; others remain unchanged.
     *
     * @param id - PostgreSQL UUID of the user.
     * @param input - Fields to update.
     * @returns The updated User.
     */
    async updateProfile(id: string, input: UpdateProfileInput): Promise<User> {
        const setClauses: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (input.displayName !== undefined) {
            setClauses.push(`display_name = $${paramIndex}`);
            values.push(input.displayName);
            paramIndex++;
        }

        if (input.avatarUrl !== undefined) {
            setClauses.push(`avatar_url = $${paramIndex}`);
            values.push(input.avatarUrl);
            paramIndex++;
        }

        setClauses.push(`updated_at = NOW()`);
        values.push(id);

        const result = await this.pool.query(
            `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, email, display_name, avatar_url, roles,
                 is_verified_traveler, verified_traveler_ticket_url,
                 last_login_at, created_at, updated_at`,
            values,
        );

        return mapRowToUser(result.rows[0] as Record<string, unknown>);
    }

    /**
     * Retrieves all emergency contacts for a user.
     * @param userId - PostgreSQL UUID of the user.
     * @returns Array of emergency contacts.
     */
    async getEmergencyContacts(userId: string): Promise<EmergencyContact[]> {
        const result = await this.pool.query(
            `SELECT id, user_id, name, phone, relation, created_at
       FROM emergency_contacts
       WHERE user_id = $1
       ORDER BY created_at ASC`,
            [userId],
        );

        return result.rows.map((row) => mapRowToEmergencyContact(row as Record<string, unknown>));
    }

    /**
     * Atomically replaces all emergency contacts for a user.
     * Uses a transaction: DELETE existing → INSERT new ones.
     *
     * @param userId - PostgreSQL UUID of the user.
     * @param contacts - New emergency contacts to insert.
     */
    async replaceEmergencyContacts(
        userId: string,
        contacts: EmergencyContactInput[],
    ): Promise<void> {
        const client: PoolClient = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Delete all existing contacts for this user
            await client.query('DELETE FROM emergency_contacts WHERE user_id = $1', [userId]);

            // Insert new contacts
            for (const contact of contacts) {
                await client.query(
                    `INSERT INTO emergency_contacts (user_id, name, phone, relation)
           VALUES ($1, $2, $3, $4)`,
                    [userId, contact.name, contact.phone, contact.relation],
                );
            }

            await client.query('COMMIT');
        } catch (error: unknown) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Marks a user as a verified traveler with their ticket URL.
     * @param userId - PostgreSQL UUID of the user.
     * @param ticketUrl - URL of the verification ticket/document.
     */
    async setVerifiedTraveler(userId: string, ticketUrl: string): Promise<void> {
        await this.pool.query(
            `UPDATE users
       SET is_verified_traveler = TRUE,
           verified_traveler_ticket_url = $2,
           updated_at = NOW()
       WHERE id = $1`,
            [userId, ticketUrl],
        );
    }
}
