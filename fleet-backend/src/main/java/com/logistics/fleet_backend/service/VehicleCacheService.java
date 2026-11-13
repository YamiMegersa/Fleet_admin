package com.logistics.fleet_backend.service;

import com.logistics.fleet_backend.model.Vehicle;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.util.concurrent.TimeUnit;

@Service
public class VehicleCacheService {
    private final RedisTemplate<String, Object> redisTemplate;
    private static final String VEHICLE_CACHE_KEY = "vehicle:";

    private static final long CACHE_TTL_MINUTES = 30; 

    public VehicleCacheService(RedisTemplate<String, Object> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    // Cache vehicle location
    public void cacheVehicleLocation(Vehicle vehicle) {
        String key = VEHICLE_CACHE_KEY + vehicle.getTruckId();
        redisTemplate.opsForValue().set(key, vehicle, CACHE_TTL_MINUTES, TimeUnit.MINUTES);
    }

    // Get cached vehicle (fast read)
    public Vehicle getCachedVehicle(String truckId) {
        String key = VEHICLE_CACHE_KEY + truckId;
        
        Object cached = redisTemplate.opsForValue().get(key);
        if (cached instanceof Vehicle) {
            return (Vehicle) cached;
        }
        return null;
    }

    // Remove from cache
    public void evictVehicle(String truckId) {
        String key = VEHICLE_CACHE_KEY + truckId;
        redisTemplate.delete(key);
    }
}
