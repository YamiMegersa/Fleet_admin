package com.logistics.fleet_backend.service;

import com.logistics.fleet_backend.model.Route;
import com.logistics.fleet_backend.model.RouteWaypoint;
import com.logistics.fleet_backend.model.RouteDeviation;
import com.logistics.fleet_backend.repository.RouteRepository;
import com.logistics.fleet_backend.repository.RouteWaypointRepository;
import com.logistics.fleet_backend.repository.RouteDeviationRepository;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class AnomalyDetectionService {

    private final RouteRepository routeRepository;
    private final RouteWaypointRepository waypointRepository;
    private final RouteDeviationRepository deviationRepository;
    private final SimpMessagingTemplate messagingTemplate;

    // Deviation thresholds in meters
    private static final double HIGH_THRESHOLD = 1000;
    private static final double MEDIUM_THRESHOLD = 500;
    private static final double LOW_THRESHOLD = 200;

    public AnomalyDetectionService(RouteRepository routeRepository,
                                   RouteWaypointRepository waypointRepository,
                                   RouteDeviationRepository deviationRepository,
                                   SimpMessagingTemplate messagingTemplate) {
        this.routeRepository = routeRepository;
        this.waypointRepository = waypointRepository;
        this.deviationRepository = deviationRepository;
        this.messagingTemplate = messagingTemplate;
    }

    /**
     * Haversine formula to calculate distance between two coordinates
     */
    public static double haversineDistance(double lat1, double lon1, double lat2, double lon2) {
        final int R = 6371000; // Earth's radius in meters
        double latRad1 = Math.toRadians(lat1);
        double latRad2 = Math.toRadians(lat2);
        double deltaLat = Math.toRadians(lat2 - lat1);
        double deltaLon = Math.toRadians(lon2 - lon1);

        double a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                Math.cos(latRad1) * Math.cos(latRad2) *
                Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
        double c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Calculate distance from a point to a line segment
     */
    public static double pointToLineDistance(double px, double py,
                                            double x1, double y1,
                                            double x2, double y2) {
        double dx = x2 - x1;
        double dy = y2 - y1;

        // If line is a point
        if (dx == 0 && dy == 0) {
            return haversineDistance(px, py, x1, y1);
        }

        // Parameter t represents position on line
        double t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);

        // Clamp to line segment
        t = Math.max(0, Math.min(1, t));

        // Closest point on line
        double closestX = x1 + t * dx;
        double closestY = y1 + t * dy;

        return haversineDistance(px, py, closestX, closestY);
    }

    /**
     * Check if a truck has deviated from its route
     */
    public RouteDeviation checkDeviation(String truckId, double currentLat, double currentLon) {
        // 1. Get active route for truck
        Route route = routeRepository.findByTruckIdAndStatus(truckId, "ACTIVE").orElse(null);
        if (route == null) {
            return null;
        }

        // 2. Get all waypoints sorted by sequence
        List<RouteWaypoint> waypoints = waypointRepository.findByRouteIdOrderBySequenceNumber(route.getRouteId());
        if (waypoints == null || waypoints.size() < 2) {
            return null;
        }

        // 3. Find closest segment on route
        double minDistance = Double.MAX_VALUE;

        for (int i = 0; i < waypoints.size() - 1; i++) {
            double dist = pointToLineDistance(
                    currentLat, currentLon,
                    waypoints.get(i).getLatitude(), waypoints.get(i).getLongitude(),
                    waypoints.get(i + 1).getLatitude(), waypoints.get(i + 1).getLongitude()
            );
            if (dist < minDistance) {
                minDistance = dist;
            }
        }

        // 4. Check if deviation exceeds threshold
        if (minDistance > LOW_THRESHOLD) {
            return createDeviationAlert(truckId, route, minDistance, currentLat, currentLon);
        }

        return null;
    }

    /**
     * Create or update an active deviation alert
     */
    private RouteDeviation createDeviationAlert(String truckId, Route route, 
                                                 double deviationDistance,
                                                 double currentLat, double currentLon) {
        // Check if there is already an active (unresolved) deviation for this truck on this route
        List<RouteDeviation> existing = deviationRepository.findByTruckId(truckId);
        RouteDeviation active = existing.stream()
                .filter(d -> ("NEW".equals(d.getStatus()) || "ACKNOWLEDGED".equals(d.getStatus())) 
                             && route.getRouteId().equals(d.getRouteId()))
                .findFirst()
                .orElse(null);

        RouteDeviation deviationToSave;
        if (active != null) {
            // Update existing active deviation rather than flooding DB with duplicate rows
            active.setDeviationDistance(deviationDistance);
            active.setCurrentLat(currentLat);
            active.setCurrentLon(currentLon);
            active.setDetectedAt(LocalDateTime.now());
            if (deviationDistance > HIGH_THRESHOLD) {
                active.setSeverity("HIGH");
            } else if (deviationDistance > MEDIUM_THRESHOLD) {
                active.setSeverity("MEDIUM");
            } else {
                active.setSeverity("LOW");
            }
            deviationToSave = active;
        } else {
            String deviationId = "DEV-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
            deviationToSave = new RouteDeviation(
                    deviationId,
                    route.getRouteId(),
                    truckId,
                    deviationDistance,
                    currentLat,
                    currentLon
            );
        }

        // Save to database
        RouteDeviation saved = deviationRepository.save(deviationToSave);

        // Send real-time notification via WebSocket
        messagingTemplate.convertAndSend("/topic/deviations", saved);

        System.out.println("⚠️ ROUTE DEVIATION: " + truckId + " - " + String.format("%.1f", deviationDistance) + "m (" + saved.getSeverity() + ")");

        return saved;
    }

    /**
     * Acknowledge a deviation
     */
    public RouteDeviation acknowledgeDeviation(String deviationId) {
        RouteDeviation deviation = deviationRepository.findById(deviationId)
                .orElseThrow(() -> new RuntimeException("Deviation not found: " + deviationId));
        deviation.setStatus("ACKNOWLEDGED");
        return deviationRepository.save(deviation);
    }

    /**
     * Resolve a deviation
     */
    public RouteDeviation resolveDeviation(String deviationId) {
        RouteDeviation deviation = deviationRepository.findById(deviationId)
                .orElseThrow(() -> new RuntimeException("Deviation not found: " + deviationId));
        deviation.setStatus("RESOLVED");
        return deviationRepository.save(deviation);
    }

    /**
     * Get all active deviations
     */
    public List<RouteDeviation> getActiveDeviations() {
        return deviationRepository.findByStatus("NEW");
    }

    /**
     * Get all deviations
     */
    public List<RouteDeviation> getAllDeviations() {
        return deviationRepository.findAll();
    }

    /**
     * Get deviations for a specific truck
     */
    public List<RouteDeviation> getDeviationsByTruck(String truckId) {
        return deviationRepository.findByTruckId(truckId);
    }
}
