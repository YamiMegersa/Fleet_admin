import React, { useEffect, useState, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import { Client } from '@stomp/stompjs';
import L from 'leaflet';

// Helper component to smoothly center/fly the map when a truck is selected
function MapFlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target && target.lat && target.lng) {
      map.flyTo([target.lat, target.lng], 14, { duration: 1.2 });
    }
  }, [target, map]);
  return null;
}

// Marker Icon Creators using Leaflet DivIcons (No broken PNG asset paths)
const createTruckIcon = (truckId, isDeviating, severity) => {
  let color = '#2563eb'; // normal blue
  let iconEmoji = '🚚';

  if (isDeviating) {
    iconEmoji = '⚠️';
    if (severity === 'HIGH') color = '#dc2626';
    else if (severity === 'MEDIUM') color = '#ea580c';
    else color = '#eab308';
  }

  return L.divIcon({
    className: 'fleet-truck-icon',
    html: `
      <div style="
        background-color: ${color};
        color: white;
        border: 2px solid #ffffff;
        border-radius: 9999px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 4px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
        white-space: nowrap;
        transform: translate(-50%, -50%);
        ${isDeviating ? 'animation: pulse 1.5s infinite;' : ''}
      ">
        <span>${iconEmoji}</span>
        <span>${truckId}</span>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -15],
  });
};

const createWarehouseIcon = (name, type) => {
  return L.divIcon({
    className: 'fleet-warehouse-icon',
    html: `
      <div style="
        background-color: #0f172a;
        color: #38bdf8;
        border: 2px solid #38bdf8;
        border-radius: 6px;
        padding: 3px 6px;
        font-size: 10px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 4px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
        white-space: nowrap;
        transform: translate(-50%, -50%);
      ">
        <span>${type === 'DEPOT' ? '⛽' : '🏢'}</span>
        <span>${name}</span>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -15],
  });
};

export default function FleetMap() {
  const [vehicles, setVehicles] = useState({});
  const [deviations, setDeviations] = useState({});
  const [locations, setLocations] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [focusTarget, setFocusTarget] = useState(null);

  // Layer visibility toggles
  const [showWarehouses, setShowWarehouses] = useState(true);
  const [showCorridors, setShowCorridors] = useState(true);
  const [showTrails, setShowTrails] = useState(true);

  // 1. Initial Load: Fetch static logistics hubs and active planned routes
  useEffect(() => {
    const fetchWithFallback = async (path) => {
      try {
        const res = await fetch(path);
        if (res.ok) return await res.json();
      } catch {
        // Fallback to direct backend URL if proxy is bypassed
      }
      try {
        const res = await fetch(`http://localhost:8080${path}`);
        if (res.ok) return await res.json();
      } catch (err) {
        console.log(`Failed to fetch ${path}:`, err.message);
      }
      return [];
    };

    // Fetch warehouses
    fetchWithFallback('/api/locations').then((data) => {
      if (Array.isArray(data)) setLocations(data);
    });

    // Fetch planned routes and their waypoints
    fetchWithFallback('/api/routes').then(async (routeList) => {
      if (!Array.isArray(routeList)) return;
      const enrichedRoutes = await Promise.all(
        routeList.map(async (route) => {
          const waypoints = await fetchWithFallback(`/api/routes/${route.routeId}/waypoints`);
          return { ...route, waypoints: Array.isArray(waypoints) ? waypoints : [] };
        })
      );
      setRoutes(enrichedRoutes);
    });
  }, []);

  // 2. WebSocket Real-Time Connection
  useEffect(() => {
    const client = new Client({
      brokerURL: 'ws://localhost:8080/ws',
      reconnectDelay: 5000,
      heartbeatIncoming: 4000,
      heartbeatOutgoing: 4000,

      onConnect: () => {
        console.log('✅ Connected to Fleet STOMP Broker!');
        setIsConnected(true);

        // A. Subscribe to live vehicle telemetry
        client.subscribe('/topic/updates', (message) => {
          try {
            const data = JSON.parse(message.body);
            const truckId = data.truckId || data.id || 'Unknown-Truck';
            const newPoint = { lat: data.latitude, lng: data.longitude };

            setVehicles((prev) => {
              const existing = prev[truckId] || { path: [] };
              // Keep maximum last 40 points in history trail for performance
              const updatedPath = [...existing.path, newPoint].slice(-40);
              return {
                ...prev,
                [truckId]: {
                  currentLocation: newPoint,
                  path: updatedPath,
                  updatedAt: new Date().toLocaleTimeString(),
                },
              };
            });
          } catch (e) {
            console.error('Error parsing telemetry:', e);
          }
        });

        // B. Subscribe to live route anomaly deviations
        client.subscribe('/topic/deviations', (message) => {
          try {
            const dev = JSON.parse(message.body);
            setDeviations((prev) => ({
              ...prev,
              [dev.truckId]: {
                ...dev,
                detectedTime: new Date(dev.detectedAt || Date.now()).toLocaleTimeString(),
              },
            }));
          } catch (e) {
            console.error('Error parsing deviation alert:', e);
          }
        });
      },

      onDisconnect: () => {
        setIsConnected(false);
      },
      onStompError: () => {
        setIsConnected(false);
      },
      onWebSocketClose: () => {
        setIsConnected(false);
      },
    });

    client.activate();

    return () => {
      client.deactivate();
    };
  }, []);

  // Derived alert list
  const activeAlerts = useMemo(() => {
    return Object.values(deviations).sort(
      (a, b) => (b.deviationDistance || 0) - (a.deviationDistance || 0)
    );
  }, [deviations]);

  return (
    <div className="app-container">
      {/* Operations Control HUD */}
      <div className="fleet-hud">
        <div className="hud-header">
          <div className="hud-title">
            <span>📡</span> Fleet Admin
          </div>
          <div className={`connection-pill ${isConnected ? 'connected' : 'disconnected'}`}>
            <span>{isConnected ? '●' : '○'}</span>
            <span>{isConnected ? 'LIVE' : 'OFFLINE'}</span>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="hud-stats-grid">
          <div className="stat-card">
            <span className="stat-value">{Object.keys(vehicles).length}</span>
            <span className="stat-label">Trucks</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{locations.length}</span>
            <span className="stat-label">Hubs</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{routes.length}</span>
            <span className="stat-label">Routes</span>
          </div>
          <div className="stat-card">
            <span className={`stat-value ${activeAlerts.length > 0 ? 'alert-stat' : ''}`}>
              {activeAlerts.length}
            </span>
            <span className="stat-label">Alerts</span>
          </div>
        </div>

        {/* Layer Toggles */}
        <div className="hud-toggles">
          <label className="toggle-item">
            <input
              type="checkbox"
              checked={showWarehouses}
              onChange={(e) => setShowWarehouses(e.target.checked)}
            />
            <span>Hubs</span>
          </label>
          <label className="toggle-item">
            <input
              type="checkbox"
              checked={showCorridors}
              onChange={(e) => setShowCorridors(e.target.checked)}
            />
            <span>Corridors</span>
          </label>
          <label className="toggle-item">
            <input
              type="checkbox"
              checked={showTrails}
              onChange={(e) => setShowTrails(e.target.checked)}
            />
            <span>Trails</span>
          </label>
        </div>

        {/* Live Anomaly Detection Feed */}
        <div className="hud-alerts-section">
          <div className="alerts-header">
            <span>Route Anomaly Alerts</span>
            {activeAlerts.length > 0 && <span>({activeAlerts.length})</span>}
          </div>

          <div className="alerts-list">
            {activeAlerts.length === 0 ? (
              <div className="no-alerts">All vehicles within planned corridor tolerance (&lt;200m).</div>
            ) : (
              activeAlerts.map((alert) => (
                <div key={alert.deviationId || alert.truckId} className={`alert-item severity-${alert.severity}`}>
                  <div className="alert-top">
                    <span className="alert-truck">🚚 {alert.truckId}</span>
                    <span className={`alert-badge ${alert.severity}`}>{alert.severity}</span>
                  </div>
                  <div className="alert-details">
                    <span>
                      Off route: <b>{Math.round(alert.deviationDistance)}m</b> ({alert.detectedTime})
                    </span>
                    <button
                      className="btn-locate"
                      onClick={() => setFocusTarget({ lat: alert.currentLat, lng: alert.currentLon })}
                    >
                      Locate
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Interactive Map */}
      <MapContainer
        center={[-33.9249, 18.4241]}
        zoom={12}
        style={{ height: '100vh', width: '100vw' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* FlyTo Camera Controller */}
        <MapFlyTo target={focusTarget} />

        {/* 1. Warehouses & Depots Layer */}
        {showWarehouses &&
          locations.map((loc) => (
            <Marker
              key={loc.locationId}
              position={[loc.latitude, loc.longitude]}
              icon={createWarehouseIcon(loc.name, loc.type)}
            >
              <Popup>
                <div>
                  <h4 style={{ margin: '0 0 4px 0' }}>🏢 {loc.name}</h4>
                  <p style={{ margin: '0 0 2px 0', fontSize: '11px', color: '#64748b' }}>
                    Type: <b>{loc.type}</b> (ID: {loc.locationId})
                  </p>
                  <p style={{ margin: '0', fontSize: '11px' }}>
                    Coords: {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                  </p>
                </div>
              </Popup>
            </Marker>
          ))}

        {/* 2. Planned Route Corridors Layer */}
        {showCorridors &&
          routes.map((route) => {
            if (!route.waypoints || route.waypoints.length === 0) return null;
            const corridorPositions = route.waypoints
              .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
              .map((wp) => [wp.latitude, wp.longitude]);

            return (
              <React.Fragment key={route.routeId}>
                <Polyline
                  positions={corridorPositions}
                  color="#10b981"
                  weight={5}
                  dashArray="8, 8"
                  opacity={0.8}
                >
                  <Popup>
                    <div>
                      <h4 style={{ margin: '0 0 4px 0' }}>🛣️ {route.routeId}</h4>
                      <p style={{ margin: '0 0 2px 0', fontSize: '12px' }}>
                        Assigned: <b>{route.truckId}</b> | Status: <b>{route.status}</b>
                      </p>
                      <p style={{ margin: '0', fontSize: '11px', color: '#64748b' }}>
                        From {route.startLocationId} to {route.endLocationId}
                      </p>
                    </div>
                  </Popup>
                </Polyline>
              </React.Fragment>
            );
          })}

        {/* 3. Live Vehicles & Breadcrumb Trails Layer */}
        {Object.entries(vehicles).map(([truckId, truckData]) => {
          const dev = deviations[truckId];
          const isDeviating = !!dev && dev.status !== 'RESOLVED';
          const severity = dev?.severity || 'LOW';

          return (
            <React.Fragment key={truckId}>
              {/* Vehicle Breadcrumb Trail */}
              {showTrails && truckData.path && truckData.path.length > 1 && (
                <Polyline
                  positions={truckData.path.map((p) => [p.lat, p.lng])}
                  color={isDeviating ? '#f87171' : '#3b82f6'}
                  weight={3}
                  opacity={0.6}
                />
              )}

              {/* Vehicle Marker */}
              <Marker
                position={[truckData.currentLocation.lat, truckData.currentLocation.lng]}
                icon={createTruckIcon(truckId, isDeviating, severity)}
              >
                <Popup>
                  <div>
                    <h4 style={{ margin: '0 0 4px 0' }}>🚚 {truckId}</h4>
                    {isDeviating ? (
                      <div
                        style={{
                          background: '#fee2e2',
                          color: '#991b1b',
                          padding: '4px 6px',
                          borderRadius: '4px',
                          marginBottom: '6px',
                          fontSize: '11px',
                          fontWeight: 700,
                        }}
                      >
                        ⚠️ OFF ROUTE: {Math.round(dev.deviationDistance)}m ({severity})
                      </div>
                    ) : (
                      <div
                        style={{
                          background: '#dcfce7',
                          color: '#166534',
                          padding: '3px 6px',
                          borderRadius: '4px',
                          marginBottom: '6px',
                          fontSize: '11px',
                          fontWeight: 600,
                        }}
                      >
                        ✅ On Planned Route
                      </div>
                    )}
                    <div style={{ fontSize: '12px', color: '#334155' }}>
                      Latitude: {truckData.currentLocation.lat.toFixed(6)}<br />
                      Longitude: {truckData.currentLocation.lng.toFixed(6)}<br />
                      Last Update: {truckData.updatedAt || 'Just now'}
                    </div>
                  </div>
                </Popup>
              </Marker>
            </React.Fragment>
          );
        })}
      </MapContainer>
    </div>
  );
}
