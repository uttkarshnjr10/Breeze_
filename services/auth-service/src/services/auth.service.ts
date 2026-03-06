/**
 * @module @breeze/auth-service/services/auth
 * AuthService — orchestration layer for authentication flows.
 * Delegates to JWTService for token operations and UserRepository for data access.
 * Business logic lives here — controllers and repositories are kept thin.
 */

import * as firebaseAdmin from 'firebase-admin';
import { UnauthorizedError, NotFoundError, ValidationError } from '@breeze/shared';
import { JWTService, type TokenPair } from './jwt.service.js';
import {
    UserRepository,
    type User,
    type EmergencyContactInput,
    type UpdateProfileInput,
} from '../repositories/user.repository.js';

// ─── Types ─────────────────────────────────────────────────────

/** Result of a successful login. */
export interface LoginResult {
    readonly user: User;
    readonly tokens: TokenPair;
}

/** Result of a token refresh. */
export interface RefreshResult {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly refreshJti: string;
}

// ─── Service ───────────────────────────────────────────────────

/**
 * Orchestrates authentication, authorization, and profile management.
 */
export class AuthService {
    private readonly jwtService: JWTService;
    private readonly userRepository: UserRepository;

    /**
     * @param jwtService - Service for JWT operations.
     * @param userRepository - Repository for user data access.
     */
    constructor(jwtService: JWTService, userRepository: UserRepository) {
        this.jwtService = jwtService;
        this.userRepository = userRepository;
    }

    /**
     * Authenticates a user via a Firebase ID token from Google OAuth.
     * Flow: Verify Firebase token → upsert user → issue JWT pair.
     *
     * @param idToken - Firebase ID token from the client.
     * @returns Login result containing user data and token pair.
     * @throws UnauthorizedError if Firebase token verification fails.
     */
    async loginWithFirebaseToken(idToken: string): Promise<LoginResult> {
        // Verify the Firebase ID token
        let decodedToken: firebaseAdmin.auth.DecodedIdToken;

        try {
            decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Firebase token verification failed';
            throw new UnauthorizedError(`Invalid Firebase ID token: ${message}`);
        }

        const { uid, email, name, picture } = decodedToken;

        if (!email) {
            throw new ValidationError('Firebase token does not contain an email address');
        }

        // Upsert user — single atomic SQL statement
        const user = await this.userRepository.upsertFromFirebase({
            firebaseUid: uid,
            email,
            displayName: name ?? email.split('@')[0] ?? 'Traveler',
            avatarUrl: picture,
        });

        // Issue JWT token pair
        const tokens = await this.jwtService.issueTokenPair(user.id, user.email, user.roles);

        return { user, tokens };
    }

    /**
     * Refreshes an access token using a valid refresh token.
     * Flow: Verify refresh token → revoke old jti → issue new pair.
     *
     * @param refreshToken - The current refresh token.
     * @returns New token pair with fresh access and refresh tokens.
     * @throws UnauthorizedError if the refresh token is invalid or revoked.
     */
    async refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
        // Verify the refresh token (checks signature + Redis)
        const payload = await this.jwtService.verifyRefreshToken(refreshToken);

        // Revoke the old refresh token to prevent reuse
        if (payload.jti) {
            await this.jwtService.revokeRefreshToken(payload.jti);
        }

        // Issue a new token pair
        const newTokens = await this.jwtService.issueTokenPair(
            payload.userId,
            payload.email,
            payload.roles,
        );

        return {
            accessToken: newTokens.accessToken,
            refreshToken: newTokens.refreshToken,
            refreshJti: newTokens.refreshJti,
        };
    }

    /**
     * Logs out a user by revoking their refresh token.
     * @param jti - The jti of the refresh token to revoke.
     */
    async logout(jti: string): Promise<void> {
        await this.jwtService.revokeRefreshToken(jti);
    }

    /**
     * Updates a user's profile.
     * @param userId - PostgreSQL UUID of the user.
     * @param data - Fields to update (displayName, avatarUrl).
     * @returns The updated user.
     * @throws NotFoundError if the user does not exist.
     */
    async updateProfile(userId: string, data: UpdateProfileInput): Promise<User> {
        const existing = await this.userRepository.findById(userId);
        if (!existing) {
            throw new NotFoundError('User not found', { userId });
        }

        return this.userRepository.updateProfile(userId, data);
    }

    /**
     * Replaces all emergency contacts for a user.
     * @param userId - PostgreSQL UUID of the user.
     * @param contacts - New emergency contacts.
     * @throws NotFoundError if the user does not exist.
     */
    async replaceEmergencyContacts(
        userId: string,
        contacts: EmergencyContactInput[],
    ): Promise<void> {
        const existing = await this.userRepository.findById(userId);
        if (!existing) {
            throw new NotFoundError('User not found', { userId });
        }

        await this.userRepository.replaceEmergencyContacts(userId, contacts);
    }

    /**
     * Gets the full user profile including emergency contacts.
     * @param userId - PostgreSQL UUID.
     * @returns User object.
     * @throws NotFoundError if user doesn't exist.
     */
    async getUserProfile(userId: string): Promise<User> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundError('User not found', { userId });
        }
        return user;
    }

    /**
     * Gets emergency contacts for a user.
     * @param userId - PostgreSQL UUID.
     * @returns Array of emergency contacts.
     */
    async getEmergencyContacts(userId: string): Promise<EmergencyContactInput[]> {
        return this.userRepository.getEmergencyContacts(userId);
    }
}
