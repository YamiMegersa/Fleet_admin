-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add spatial column to Location table
ALTER TABLE location ADD COLUMN IF NOT EXISTS location geometry(Point, 4326);

-- Update geometry for existing rows
UPDATE location SET location = ST_SetSRID(
    ST_MakePoint(longitude, latitude), 4326
);

-- Create spatial index
CREATE INDEX IF NOT EXISTS location_location_idx ON location USING GIST(location);

-- For vehicle proximity queries
-- Find all warehouses within 5km of a point:
SELECT * FROM location
WHERE ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint(18.4241, -33.9249), 4326),
    5000  -- 5km in meters
);
