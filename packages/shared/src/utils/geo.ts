/**
 * @module @breeze/shared/utils/geo
 * Geographic utility functions for the Breeze platform.
 * All calculations use the Haversine formula for great-circle distances.
 */

import type { GeoPoint, TileCoords } from '../types/index.js';

/** Mean radius of Earth in kilometers. */
const EARTH_RADIUS_KM = 6371;

/** Conversion factor from degrees to radians. */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Converts degrees to radians.
 * @param degrees - Angle in degrees.
 * @returns Angle in radians.
 */
function toRadians(degrees: number): number {
    return degrees * DEG_TO_RAD;
}

/**
 * Calculates the great-circle distance between two points using the Haversine formula.
 * @param lat1 - Latitude of the first point in degrees.
 * @param lng1 - Longitude of the first point in degrees.
 * @param lat2 - Latitude of the second point in degrees.
 * @param lng2 - Longitude of the second point in degrees.
 * @returns Distance in kilometers.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const radLat1 = toRadians(lat1);
    const radLat2 = toRadians(lat2);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_KM * c;
}

/**
 * Calculates the great-circle distance between two points in meters.
 * @param lat1 - Latitude of the first point in degrees.
 * @param lng1 - Longitude of the first point in degrees.
 * @param lat2 - Latitude of the second point in degrees.
 * @param lng2 - Longitude of the second point in degrees.
 * @returns Distance in meters.
 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}

/**
 * Checks if a point is within a given radius of a center point.
 * @param point - The point to check.
 * @param center - The center of the radius.
 * @param radiusKm - The radius in kilometers.
 * @returns True if the point is within the radius.
 */
export function isWithinRadius(point: GeoPoint, center: GeoPoint, radiusKm: number): boolean {
    const distance = haversineKm(
        point.latitude,
        point.longitude,
        center.latitude,
        center.longitude,
    );
    return distance <= radiusKm;
}

/**
 * Converts latitude/longitude to Slippy Map tile coordinates at a given zoom level.
 * Uses the OpenStreetMap tile numbering scheme.
 * @param lat - Latitude in degrees.
 * @param lng - Longitude in degrees.
 * @param zoom - Zoom level (0–23).
 * @returns Tile coordinates { x, y, z }.
 */
export function latLngToTileXYZ(lat: number, lng: number, zoom: number): TileCoords {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = toRadians(lat);
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);

    return { x, y, z: zoom };
}
