package com.logistics.fleet_backend.controller;

import com.logistics.fleet_backend.model.Vehicle;
import com.logistics.fleet_backend.repository.VehicleRepository;
import com.logistics.fleet_backend.service.VehicleCacheService;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/vehicles")
public class VehicleController {

    private final VehicleRepository repository;
    private final VehicleCacheService cacheService;
    private final KafkaTemplate<String, Object> kafkaTemplate;
    private static final String TOPIC = "vehicle-updates";
    
    public VehicleController(VehicleRepository repository, 
                             VehicleCacheService cacheService,
                             KafkaTemplate<String, Object> kafkaTemplate) {
        System.out.println("--------------------------------------");
        System.out.println("🚨 VEHICLE CONTROLLER IS LOADED 🚨");
        System.out.println("--------------------------------------");
        this.repository = repository;
        this.cacheService = cacheService;
        this.kafkaTemplate = kafkaTemplate;
    }

    // Health check endpoint
    @GetMapping("/ping")
    public String ping() {
        return "Pong! Server is alive.";
    }

    @GetMapping
    public List<Vehicle> getAllVehicles() {
        return repository.findAll();
    }

    @GetMapping("/{truckId}")
    public Vehicle getVehicle(@PathVariable String truckId) {
        // Try cache first
        Vehicle cached = cacheService.getCachedVehicle(truckId);
        if (cached != null) {
            return cached;
        }

        // Fallback to DB
        return repository.findById(truckId).orElse(null);
    }

    @PostMapping
    public Vehicle updateLocation(@RequestBody Vehicle vehicle) {
        // 1. Save to database (Persistent)
        Vehicle savedVehicle = repository.save(vehicle);

        // 2. Save to cache (Fast access)
        cacheService.cacheVehicleLocation(savedVehicle);

        // 3. Send to Kafka topic (async, non-blocking ingestion decoupling)
        // Downstream analytics (anomaly detection, WebSocket push) are handled by VehicleAnalyticsConsumer
        kafkaTemplate.send(TOPIC, savedVehicle.getTruckId(), savedVehicle);
        
        return savedVehicle;
    }
}
