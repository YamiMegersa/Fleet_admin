# PostGIS Setup Script for Fleet Logistics (PowerShell)
# Run this script to set up the database with PostGIS extension

# Database connection settings (match application.properties)
$DB_HOST = "localhost"
$DB_PORT = "5432"
$DB_NAME = "fleet_logistics"
$DB_USER = "postgres"
$DB_PASSWORD = "art3ZH9gMzxjDR1L"

# Path to psql executable
$PSQL = "C:\Program Files\PostgreSQL\18\bin\psql.exe"

$env:PGPASSWORD = $DB_PASSWORD

Write-Host "========================================"
Write-Host "PostGIS Setup for Fleet Logistics"
Write-Host "========================================"

Write-Host "`nStep 1: Enabling PostGIS extension..."
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "CREATE EXTENSION IF NOT EXISTS postgis;"

Write-Host "`nStep 2: Adding spatial columns to vehicle and location tables..."
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS location geometry(Point, 4326);"
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "ALTER TABLE location ADD COLUMN IF NOT EXISTS location geometry(Point, 4326);"

Write-Host "`nStep 3: Updating geometry for existing rows..."
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "UPDATE vehicle SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326);"
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "UPDATE location SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326);"

Write-Host "`nStep 4: Creating spatial indexes..."
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "CREATE INDEX IF NOT EXISTS vehicle_location_idx ON vehicle USING GIST(location);"
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "CREATE INDEX IF NOT EXISTS location_location_idx ON location USING GIST(location);"

Write-Host "`nStep 5: Testing proximity query (locations within 5km of Cape Town)..."
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT * FROM location WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(18.4241, -33.9249), 4326), 5000);"

Write-Host "`nStep 6: Verifying PostGIS installation..."
& $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT postgis_full_version();"

Write-Host "`n========================================"
Write-Host "PostGIS setup complete!"
Write-Host "========================================"
