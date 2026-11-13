# Fleet Backend - Implementation Guide

## Priority 1: Multi-Truck Simulator (Concurrency) ✅ GUIDE PROVIDED

See Section 1 below for complete implementation details.

---

## Priority 2: Redis Integration (Caching)

### Why it's important
Redis provides high-speed caching for frequently accessed data (vehicle locations), reducing database load and improving response times for real-time queries.

### Implementation Overview

**Concept:** Cache vehicle locations in Redis instead of hitting PostgreSQL for every read:
1. On vehicle location update: Save to both PostgreSQL (persistent) and Redis (cache)
2. On vehicle location query: Check Redis first, fallback to PostgreSQL
3. Use TTL (Time To Live) for cache expiration

### pom.xml Changes Needed

Add these dependencies to `pom.xml`:

```
xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

### Configuration (application.properties)

```
properties
# Redis Configuration
spring.data.redis.host=localhost
spring.data.redis.port=6379
spring.data.redis.timeout=2000
```

### Skeleton Code

**1. Redis Configuration Class:**

```
java
package com.logistics.fleet_backend.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;

@Configuration
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory connectionFactory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());

        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());

        template.setHashKeySerializer(new StringRedisSerializer());

        template.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());
        return template;
    }
}
```

**2. Vehicle Cache Service:**

```
java
package com.logistics.fleet_backend.service;

import com.logistics.fleet_backend.model.Vehicle;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.util.concurrent.TimeUnit;

@Service
public class VehicleCacheService {

    private final RedisTemplate<String, Object> redisTemplate;

    private static final String VEHICLE_KEY_PREFIX = "vehicle:";

    private static final long CACHE_TTL_MINUTES = 30;

    public VehicleCacheService(RedisTemplate<String, Object> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    // Cache vehicle location
    public void cacheVehicle(Vehicle vehicle) {
        String key = VEHICLE_KEY_PREFIX + vehicle.getTruckId();
        redisTemplate.opsForValue().set(key, vehicle, CACHE_TTL_MINUTES, TimeUnit.MINUTES);
    }

    // Get cached vehicle (fast read)
    public Vehicle getCachedVehicle(String truckId) {
        String key = VEHICLE_KEY_PREFIX + truckId;
        Object cached = redisTemplate.opsForValue().get(key);
        if (cached instanceof Vehicle) {
            return (Vehicle) cached;
        }
        return null;
    }

    // Remove from cache
    public void evictVehicle(String truckId) {
        String key = VEHICLE_KEY_PREFIX + truckId;
        redisTemplate.delete(key);
    }
}
```

**3. Update VehicleController to use Cache:**

```
java
@RestController
@RequestMapping("/api/vehicles")
public class VehicleController {
    
    private final VehicleRepository repository;

    private final VehicleCacheService cacheService;
    
    private final SimpMessagingTemplate messagingTemplate;

    public VehicleController(VehicleRepository repository, 
                           VehicleCacheService cacheService,
                           SimpMessagingTemplate messagingTemplate) {
        this.repository = repository;
        this.cacheService = cacheService;
        this.messagingTemplate = messagingTemplate;
    }

    @GetMapping
    public List<Vehicle> getAllVehicles() {
        // Option 1: Return from cache if available
        // For full list, still query DB but could paginate
        
        // Option 2: For single vehicle, check cache first
        return repository.findAll();
    }

    @GetMapping("/{truckId}")
    public Vehicle getVehicle(@PathVariable String truckId) {
        // Try cache first
        Vehicle cached = cacheService.getCachedVehicle(truckId);
        if (cached != null) {
            return cached;
        }
        
        // Fallback to database
        return repository.findById(truckId).orElse(null);
    }

    @PostMapping
    public Vehicle updateLocation(@RequestBody Vehicle vehicle) {
        // Save to database (persistent)
        Vehicle savedVehicle = repository.save(vehicle);
        
        // Also save to cache (fast access)
        cacheService.cacheVehicle(savedVehicle);
        
        // WebSocket notification
        messagingTemplate.convertAndSend("/topic/updates", savedVehicle);
        
        return savedVehicle;
    }
}
```

### Key Concepts

1. **RedisTemplate** - Spring's abstraction for Redis operations
2. **Serialization** - Vehicles are serialized to JSON for storage
3. **TTL** - Cache expires after 30 minutes (reduces stale data)
4. **Cache-Aside Pattern** - Check cache first, fallback to DB

### Files to Create/Modify

| File | Action |
|------|--------|
| `config/RedisConfig.java` | Create new |
| `service/VehicleCacheService.java` | Create new |
| `controller/VehicleController.java` | Modify existing |
| `pom.xml` | Add Redis dependency |

---

## Priority 3: PostGIS Setup (Geospatial Queries)

### Why it's important
PostGIS enables efficient geospatial queries like "Find all trucks within 5km of this warehouse" - critical for logistics operations.

### Implementation Overview

**Concept:** Enable PostGIS extension and use spatial queries:
1. Enable PostGIS extension in PostgreSQL
2. Use spatial data types (GEOGRAPHY)
3. Create spatial indexes for performance
4. Use ST_DWithin for proximity queries

### SQL Setup (setup_postgis.sql already exists)

```
sql
-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add spatial column to Location table
ALTER TABLE location ADD COLUMN location geometry(Point, 4326);

-- Update geometry for existing rows
UPDATE location SET location = ST_SetSRID(
    ST_MakePoint(longitude, latitude), 4326
);

-- Create spatial index
CREATE INDEX idx_location_geom ON location USING GIST(location);

-- For vehicle proximity queries
-- Find all warehouses within 5km of a point:
SELECT * FROM location 
WHERE ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint(18.4241, -33.9249), 4326),
    5000  -- 5km in meters
);
```

### VehicleRepository Enhancement

```
java
package com.logistics.fleet_backend.repository;

import com.logistics.fleet_backend.model.Vehicle;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface VehicleRepository extends JpaRepository<Vehicle, String> {

    // Native PostGIS query: Find vehicles within radius (in meters)
    @Query(value = 
        "SELECT * FROM vehicle v " +
        "WHERE ST_DWithin(" +
        "  ST_MakePoint(v.longitude, v.latitude)::geography, " +
        "  ST_MakePoint(:lon, :lat)::geography, " +
        "  :radius" +
        ")", 
        nativeQuery = true)
    List<Vehicle> findVehiclesWithinRadius(
        double lat, 
        double lon, 
        double radius
    );
}
```

### LocationController Enhancement

```
java
@RestController
@RequestMapping("/api/locations")
public class LocationController {

    private final LocationRepository locationRepository;
    private final VehicleRepository vehicleRepository;

    public LocationController(LocationRepository locationRepository,
                            VehicleRepository vehicleRepository) {
        this.locationRepository = locationRepository;
        this.vehicleRepository = vehicleRepository;
    }

    /**
     * Get all trucks within X meters of a location
     */
    @GetMapping("/{locationId}/nearby-vehicles")
    public List<Vehicle> getNearbyVehicles(
            @PathVariable String locationId,
            @RequestParam(defaultValue = "5000") double radiusMeters) {
        
        Location location = locationRepository.findById(locationId).orElse(null);
        if (location == null) {
            return List.of();
        }
        
        return vehicleRepository.findVehiclesWithinRadius(
            location.getLatitude(),
            location.getLongitude(),
            radiusMeters
        );
    }
}
```

### Files to Modify

| File | Action |
|------|--------|
| `setup_postgis.sql` | Execute in PostgreSQL |
| `repository/VehicleRepository.java` | Add spatial query |
| `controller/LocationController.java` | Add proximity endpoint |

---

## Priority 4: Kafka/RabbitMQ (Event-Driven)

### Why it's important
Decouples GPS ingestion from analytics processing - allows independent scaling and fault isolation.

### Implementation Overview

**Concept:** Use message queue to separate concerns:
1. GPS Ingestion Service → sends to Kafka topic
2. Analytics Service → consumes from Kafka topic
3. Each can scale independently

### pom.xml Changes (Kafka example)

```
xml
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
```

### Configuration

```
properties
# Kafka Configuration
spring.kafka.bootstrap-servers=localhost:9092
spring.kafka.consumer.group-id=fleet-group
spring.kafka.consumer.auto-offset-reset=earliest

# Producer
spring.kafka.producer.key-serializer=org.apache.kafka.common.serialization.StringSerializer
spring.kafka.producer.value-serializer=org.springframework.kafka.support.serializer.JsonSerializer

# Consumer
spring.kafka.consumer.key-deserializer=org.apache.kafka.common.serialization.StringDeserializer
spring.kafka.consumer.value-deserializer=org.springframework.kafka.support.serializer.JsonDeserializer
```

### Kafka Producer (In VehicleController)

```
java
@RestController
@RequestMapping("/api/vehicles")
public class VehicleController {
    
    private final KafkaTemplate<String, Vehicle> kafkaTemplate;
    private static final String TOPIC = "vehicle-updates";

    @PostMapping
    public Vehicle updateLocation(@RequestBody Vehicle vehicle) {
        // Save to database
        Vehicle savedVehicle = repository.save(vehicle);
        
        // Send to Kafka topic (async, non-blocking)
        kafkaTemplate.send(TOPIC, vehicle.getTruckId(), vehicle);
        
        // Real-time WebSocket (keep for immediate updates)
        messagingTemplate.convertAndSend("/topic/updates", savedVehicle);
        
        return savedVehicle;
    }
}
```

### Kafka Consumer (Analytics Service)

```
java
package com.logistics.fleet_backend.consumer;

import com.logistics.fleet_backend.model.Vehicle;
import com.logistics.fleet_backend.service.AnomalyDetectionService;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

@Service
public class VehicleAnalyticsConsumer {

    private final AnomalyDetectionService anomalyService;

    public VehicleAnalyticsConsumer(AnomalyDetectionService anomalyService) {
        this.anomalyService = anomalyService;
    }

    @KafkaListener(topics = "vehicle-updates", groupId = "fleet-group")
    public void consumeVehicleUpdate(Vehicle vehicle) {
        System.out.println("📥 Received vehicle update: " + vehicle.getTruckId());
        
        // Run anomaly detection (background processing)
        anomalyService.checkDeviation(
            vehicle.getTruckId(),
            vehicle.getLatitude(),
            vehicle.getLongitude()
        );
        
        // Could add more analytics here:
        // - Speed calculation
        // - Route progress
        // - ETA predictions
    }
}
```

### Benefits

1. **Decoupling** - Ingestion and analytics run independently
2. **Scalability** - Add more consumers for heavy processing
3. **Reliability** - Messages persist if analytics service is down
4. **Throughput** - Handle burst traffic without blocking

### Files to Create/Modify

| File | Action |
|------|--------|
| `pom.xml` | Add Kafka dependency |
| `application.properties` | Add Kafka config |
| `controller/VehicleController.java` | Add KafkaTemplate |
| `consumer/VehicleAnalyticsConsumer.java` | Create new |
| `config/KafkaConfig.java` | Optional custom config |

---

# IMPLEMENTATION ORDER

1. **Priority 1:** Multi-Truck Simulator (Concurrency) - Guide provided above
2. **Priority 2:** Redis Integration - Guide provided above  
3. **Priority 3:** PostGIS Setup - Guide provided above
