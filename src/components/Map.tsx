import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, LayersControl, ZoomControl, Polygon, Polyline } from 'react-leaflet';
import * as L from 'leaflet';
import * as EsriLeaflet from 'esri-leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import * as EsriCluster from 'esri-leaflet-cluster';
import 'leaflet/dist/leaflet.css';
import { Location } from '../types';
import { Home, MapPin, Trash2, MousePointer, Circle, Square, Layers, Target } from 'lucide-react';
import { gisService } from '../services/gisfunctions';
import { useTranslation } from 'react-i18next';

// Fix for default marker icons
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Create a single reusable icon instance
const markerIcon = L.icon({
  iconUrl: 'data:image/svg+xml;base64,' + btoa(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
      <path d="M12 0C7.6 0 4 3.6 4 8c0 5.4 8 16 8 16s8-10.6 8-16c0-4.4-3.6-8-8-8zm0 12c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z" 
        fill="#76236C" 
        stroke="white" 
        stroke-width="1"
      />
    </svg>
  `),
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32]
});

const drawPointMarkerIcon = L.icon({
  iconUrl: 'data:image/svg+xml;base64,' + btoa(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
      <path d="M12 0C7.6 0 4 3.6 4 8c0 5.4 8 16 8 16s8-10.6 8-16c0-4.4-3.6-8-8-8zm0 12c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z" 
        fill="#28a745" 
        stroke="white" 
        stroke-width="1"
      />
    </svg>
  `),
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32]
});

// Dubai coordinates and zoom level
const DUBAI_CENTER: [number, number] = [24.290349, 54.577256];
const DUBAI_ZOOM = 8;

type DrawMode = 'none' | 'point' | 'polygon';

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  fields: string[];
}

// LayersList component
function LayersList() {
  const [showLayers, setShowLayers] = useState(false);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (layersRef.current && !layersRef.current.contains(event.target as Node)) {
        setShowLayers(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchLayers = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${gisService.getServiceUrl()}?f=json`);
      if (!response.ok) throw new Error('Failed to fetch layers');

      const data = await response.json();
      if (!data.layers) throw new Error('No layers found');

      setLayers(data.layers.map((layer: any) => ({
        id: layer.id,
        name: layer.name,
        type: layer.type,
        fields: []
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load layers');
      console.error('Error fetching layers:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleLayer = (layerId: number, visible: boolean) => {
    setLayers(prevLayers => {
      const newLayers = prevLayers.map(layer => {
        if (layer.id === layerId) {
          return { ...layer, visible };
        }
        return layer;
      });
      
      gisService.updateLayerVisibility(layerId, visible);
      
      return newLayers;
    });
  };

  return (
    <div 
      className="leaflet-top leaflet-left" 
      style={{ marginTop: '160px' }}
      ref={layersRef}
    >
      <div className="leaflet-control leaflet-bar">
        <a
          href="#"
          title={t('map.layers')}
          role="button"
          onClick={(e) => {
            e.preventDefault();
            setShowLayers(!showLayers);
            if (!layers.length) {
              fetchLayers();
            }
          }}
          className={`leaflet-control-button ${showLayers ? 'active-tool' : ''}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Layers size={16} style={{ display: 'block' }} />
        </a>
      </div>

      {showLayers && (
        <div className="layer-list-container">
          <div className="layer-list-header">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white">
              {t('map.layersList')}
            </h3>
            {loading && (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-[rgb(28,96,154)] border-t-transparent"></div>
            )}
          </div>

          {error ? (
            <div className="p-4 text-sm text-red-500 dark:text-red-400">
              {error}
            </div>
          ) : (
            <div className="layer-list-content">
              {layers.map(layer => (
                <div key={layer.id} className="layer-item">
                  <label className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={layer.visible}
                      onChange={(e) => toggleLayer(Number(layer.id), e.target.checked)}
                      className="rounded border-gray-300 text-[rgb(28,96,154)] focus:ring-[rgb(28,96,154)]"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">{layer.name}</span>
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Home button control
function HomeButton() {
  const { t } = useTranslation();
  const map = useMap();

  const handleHomeClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    setTimeout(() => {
      if (target.contains(e.target as Node)) {
        gisService.resetView();
      }
    }, 0);
  };

  return (
    <div 
      className="leaflet-top leaflet-left" 
      style={{ marginTop: '80px' }}
      onClick={e => e.stopPropagation()}
    >
      <div 
        className="leaflet-control leaflet-bar"
        onClick={e => e.stopPropagation()}
      >
        <a
          href="#"
          title={t('map.returnToDubai')}
          role="button"
          onClick={handleHomeClick}
          className="leaflet-control-button"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Home size={16} style={{ display: 'block' }} />
        </a>
      </div>
    </div>
  );
}

// Select location controls
function SelectLocationControls({ 
  isSelectActive, 
  onSelectToggle, 
  drawMode,
  onDrawModeChange
}: { 
  isSelectActive: boolean; 
  onSelectToggle: () => void;
  drawMode: DrawMode;
  onDrawModeChange: (mode: DrawMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <div 
      className="leaflet-top leaflet-left" 
      style={{ marginTop: '120px' }}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex">
        <div className="leaflet-control leaflet-bar">
          <a
            href="#"
            title={t('map.clickSelect')}
            role="button"
            onClick={(e) => {
              e.preventDefault();
              onSelectToggle();
            }}
            className={`leaflet-control-button ${isSelectActive ? 'active-tool' : ''}`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <MousePointer size={16} style={{ display: 'block' }} />
          </a>
        </div>
        {isSelectActive && (
          <>
            <div className="leaflet-control leaflet-bar ml-2">
              <a
                href="#"
                title={t('map.drawPoint')}
                role="button"
                onClick={(e) => {
                  e.preventDefault();
                  onDrawModeChange(drawMode === 'point' ? 'none' : 'point');
                }}
                className={`leaflet-control-button ${drawMode === 'point' ? 'active-tool' : ''}`}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Circle size={16} style={{ display: 'block' }} />
              </a>
            </div>
            <div className="leaflet-control leaflet-bar ml-2">
              <a
                href="#"
                title={t('map.drawPolygon')}
                role="button"
                onClick={(e) => {
                  e.preventDefault();
                  onDrawModeChange(drawMode === 'polygon' ? 'none' : 'polygon');
                }}
                className={`leaflet-control-button ${drawMode === 'polygon' ? 'active-tool' : ''}`}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Square size={16} style={{ display: 'block' }} />
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Clear graphics button control
function ClearGraphicsButton({ onClear, locations }: { onClear: () => void, locations: Location[] }) {
  const { t } = useTranslation();

  const handleClearClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    setTimeout(() => {
      if (target.contains(e.target as Node)) {
        onClear();
      }
    }, 0);
  };

  if (!locations.length) return null;

  return (
    <div 
      className="leaflet-top leaflet-left" 
      style={{ marginTop: '240px' }}
      onClick={e => e.stopPropagation()}
    >
      <div 
        className="leaflet-control leaflet-bar"
        onClick={e => e.stopPropagation()}
      >
        <a
          href="#"
          title={t('map.clearResults')}
          role="button"
          onClick={handleClearClick}
          className="leaflet-control-button"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Trash2 size={16} style={{ display: 'block' }} />
        </a>
      </div>
    </div>
  );
}

// Zoom to results button control
function ZoomToResultsButton({ onZoom, locations }: { onZoom: () => void, locations: Location[] }) {
  const { t } = useTranslation();

  const handleZoomClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    setTimeout(() => {
      if (target.contains(e.target as Node)) {
        onZoom();
      }
    }, 0);
  };

  if (!locations.length) return null;

  return (
    <div 
      className="leaflet-top leaflet-left" 
      style={{ marginTop: '200px' }}
      onClick={e => e.stopPropagation()}
    >
      <div 
        className="leaflet-control leaflet-bar"
        onClick={e => e.stopPropagation()}
      >
        <a
          href="#"
          title={t('map.zoomToResults')}
          role="button"
          onClick={handleZoomClick}
          className="leaflet-control-button"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Target size={16} style={{ display: 'block' }} />
        </a>
      </div>
    </div>
  );
}

// Component to handle map updates
function MapUpdater({
  locations,
  selectedLocation,
  isFullscreen,
  isVisible,
  clickedLocation,
  onMapClick,
  clearMarker,
  onClearGraphics,
  isSelectActive,
  onSelectToggle,
  drawMode,
  onDrawModeChange,
  onPolygonPointAdd,
  onPolygonComplete,
  polygonPoints,
  onLocationSelect
}: {
  locations: Location[];
  selectedLocation: Location | null;
  isFullscreen: boolean;
  isVisible: boolean;
  clickedLocation: [number, number] | null;
  onMapClick: (latlng: [number, number]) => void;
  clearMarker: boolean;
  onClearGraphics: () => void;
  isSelectActive: boolean;
  onSelectToggle: () => void;
  drawMode: DrawMode;
  onDrawModeChange: (mode: DrawMode) => void;
  onPolygonPointAdd: (point: [number, number]) => void;
  onPolygonComplete: () => void;
  polygonPoints: [number, number][];
  onLocationSelect: (location: Location) => void;
}) {
  const map = useRef(useMap());
  const layersRef = useRef<Record<string | number, L.Layer>>({});
  const { t } = useTranslation();

  // Effect 1: init gisService + background cluster layer (runs once on mount)
  useEffect(() => {
    gisService.setMap(map.current);

    const serviceUrl = import.meta.env.VITE_MAP_SERVICE_URL;
    if (!serviceUrl) return;

    const bgLayer = (EsriCluster as any).featureLayer({
      url: `${serviceUrl}/0`,
      pointToLayer: (_feature: any, latlng: L.LatLng) =>
        L.circleMarker(latlng, {
          radius: 5,
          color: '#1c609a',
          fillColor: '#1c609a',
          fillOpacity: 0.5,
          weight: 1,
        }),
    }).addTo(map.current);

    return () => {
      if (map.current.hasLayer(bgLayer)) map.current.removeLayer(bgLayer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: map click / dblclick handlers for draw tools
  useEffect(() => {
    const handleMapClick = (e: L.LeafletMouseEvent) => {
      if (!isSelectActive) return;
      const target = e.originalEvent.target as HTMLElement;
      if (target.closest('.leaflet-control-button')) return;
      const { lat, lng } = e.latlng;
      if (drawMode === 'point') {
        onMapClick([lat, lng]);
      } else if (drawMode === 'polygon') {
        onPolygonPointAdd([lat, lng]);
      }
    };

    const handleMapDoubleClick = (e: L.LeafletMouseEvent) => {
      if (drawMode === 'polygon' && polygonPoints.length > 2) {
        e.originalEvent.preventDefault();
        onPolygonComplete();
      }
    };

    map.current.on('click', handleMapClick);
    map.current.on('dblclick', handleMapDoubleClick);

    return () => {
      map.current.off('click', handleMapClick);
      map.current.off('dblclick', handleMapDoubleClick);
    };
  }, [isSelectActive, drawMode, onMapClick, onPolygonPointAdd, onPolygonComplete, polygonPoints]);

  useEffect(() => {
    const handleResize = () => {
      // Delay on mobile: iOS fires resize before layout reflow completes,
      // causing Leaflet to measure a stale size. 100ms covers the reflow.
      setTimeout(() => map.current?.invalidateSize({ animate: false }), 100);
    };

    // orientationchange fires on iOS when rotating device; resize alone is unreliable
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  // Invalidate map size when the panel transitions from hidden → visible.
  // Required on mobile where CSS hides/shows the map container — Leaflet
  // doesn't observe DOM size changes on its own.
  useEffect(() => {
    if (!isVisible) return;
    // Small delay so the CSS transition finishes before we measure
    const t = setTimeout(() => {
      map.current.invalidateSize({ animate: false });
    }, 50);
    return () => clearTimeout(t);
  }, [isVisible]);

  useEffect(() => {
    if (locations.length === 0 && clearMarker) {
      Object.values(layersRef.current).forEach(layer => map.current.removeLayer(layer));
      layersRef.current = {};
      return;
    }

    const currentIds = new Set(locations.map(loc => loc.id));
    Object.entries(layersRef.current).forEach(([id, layer]) => {
      if (!currentIds.has(id)) {
        map.current.removeLayer(layer);
        delete layersRef.current[id];
      }
    });

    locations.forEach(location => {
      if (!location.coordinates || !location.geometryType) return;
      if (layersRef.current[location.id]) return;

      let layer: L.Layer;

      try {
        switch (location.geometryType) {
          case 'Point':
            if (location.coordinates[0]?.[0]) {
              layer = L.marker([location.coordinates[0][1], location.coordinates[0][0]], {
                icon: markerIcon
              });
            }
            break;
          case 'MultiLineString':
          case 'LineString':
            if (Array.isArray(location.coordinates)) {
              layer = L.polyline(
                location.coordinates.map(coord => [coord[1], coord[0]]),
                {
                  color: '#76236C',
                  weight: location.id === selectedLocation?.id ? 3 : 2,
                  opacity: 1
                }
              );
            }
            break;
          case 'Polygon':
          case 'MultiPolygon':
            if (Array.isArray(location.coordinates[0])) {
              layer = L.polygon(
                location.coordinates[0].map(coord => [coord[1], coord[0]]),
                {
                  color: '#76236C',
                  weight: location.id === selectedLocation?.id ? 3 : 2,
                  opacity: 1,
                  fillOpacity: location.id === selectedLocation?.id ? 0.4 : 0.2,
                  fillColor: '#76236C',
                  className: 'animated-polygon'
                }
              );
            }
            break;
          default:
            console.warn(`Unsupported geometry type: ${location.geometryType}`);
            return;
        }

        if (!layer) return;

        // ── Build professional popup element ────────────────────────────────
        const SKIP = new Set(['id', 'coordinates', 'geometryType', 'features']);
        const popupTitle: string =
          (location as any).Property_Name ||
          (location as any).Property_ID  ||
          (location as any).Name         ||
          (location as any).name         ||
          String(location.id);

        const popupWrapper = document.createElement('div');

        // Header
        const popupHeader = document.createElement('div');
        popupHeader.className = 'popup-header';
        popupHeader.innerHTML = `
          <div class="popup-header-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
          <div class="popup-header-text">
            <div class="popup-header-title" title="${popupTitle}">${popupTitle}</div>
          </div>`;

        // Close button (closes the Leaflet popup)
        const popupCloseBtn = document.createElement('button');
        popupCloseBtn.className = 'popup-close-btn';
        popupCloseBtn.title = 'Close';
        popupCloseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.8" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>`;
        popupCloseBtn.onclick = () => layer.closePopup?.();
        popupHeader.appendChild(popupCloseBtn);
        popupWrapper.appendChild(popupHeader);

        // Attribute body
        const popupBody = document.createElement('div');
        popupBody.className = 'popup-body';

        Object.entries(location).forEach(([key, value]) => {
          if (value === undefined || value === null || SKIP.has(key)) return;
          const row = document.createElement('div');
          row.className = 'popup-row';

          const keyEl = document.createElement('span');
          keyEl.className = 'popup-key';
          keyEl.textContent = key.replace(/_/g, ' ');
          keyEl.title = key;

          const valEl = document.createElement('span');
          valEl.className = 'popup-value';
          valEl.textContent = String(value);
          valEl.title = String(value);

          row.appendChild(keyEl);
          row.appendChild(valEl);
          popupBody.appendChild(row);
        });

        popupWrapper.appendChild(popupBody);

        layer.bindPopup(popupWrapper, {
          className: 'custom-popup',
          maxWidth: 340,
          closeButton: false,
          closeOnClick: false,
        });

        layer.on('click', () => {
          onLocationSelect(location);
        });

        layer.addTo(map.current);
        layersRef.current[location.id] = layer;
      } catch (error) {
        console.error('Error creating layer:', error);
      }
    });
  }, [locations, selectedLocation, onLocationSelect, clearMarker]);

  useEffect(() => {
    if (selectedLocation) {
      const layer = layersRef.current[selectedLocation.id];
      if (layer) {
        setTimeout(() => {
          if (layer instanceof L.Marker || layer instanceof L.Polygon || layer instanceof L.Polyline) {
            layer.openPopup();
          }
        }, 100);
      }
    }
  }, [selectedLocation]);

  return (
    <>
      <HomeButton />
      <SelectLocationControls 
        isSelectActive={isSelectActive}
        onSelectToggle={onSelectToggle}
        drawMode={drawMode}
        onDrawModeChange={onDrawModeChange}
      />
      <LayersList />
      <ZoomToResultsButton 
        onZoom={() => gisService.zoomToFeatures(locations)} 
        locations={locations}
      />
      <ClearGraphicsButton onClear={onClearGraphics} locations={locations} />
    </>
  );
}

interface MapProps {
  selectedLocation: Location | null;
  locations: Location[];
  isFullscreen: boolean;
  isVisible?: boolean;          // triggers invalidateSize when map panel becomes visible
  onLocationClick?: (coordinates: [number, number]) => void;
  clearMarker?: boolean;
  onClearGraphics?: () => void;
  onPolygonComplete?: (points: [number, number][]) => void;
  onLocationSelect: (location: Location) => void;
}

const Map: React.FC<MapProps> = ({
  selectedLocation,
  locations,
  isFullscreen,
  isVisible = true,
  onLocationClick,
  clearMarker = false,
  onClearGraphics = () => {},
  onPolygonComplete = () => {},
  onLocationSelect
}) => {
  const [clickedLocation, setClickedLocation] = useState<[number, number] | null>(null);
  const [isSelectActive, setIsSelectActive] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>('none');
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const { t } = useTranslation();

  useEffect(() => {
    if (clearMarker) {
      setClickedLocation(null);
      setIsSelectActive(false);
      setDrawMode('none');
      setPolygonPoints([]);
      gisService.setDrawMode('none');
    }
  }, [clearMarker]);

  const handleMapClick = (coordinates: [number, number]) => {
    setClickedLocation(coordinates);
    if (onLocationClick) {
      onLocationClick(coordinates);
    }
  };

  const handleClearGraphics = () => {
    setClickedLocation(null);
    setIsSelectActive(false);
    setDrawMode('none');
    setPolygonPoints([]);
    gisService.setDrawMode('none');
    gisService.clearGraphics();
    onClearGraphics();
  };

  const handleSelectToggle = () => {
    const newSelectState = !isSelectActive;
    setIsSelectActive(newSelectState);
    if (!newSelectState) {
      setDrawMode('none');
      setClickedLocation(null);
      setPolygonPoints([]);
      gisService.setDrawMode('none');
    }
  };

  const handleDrawModeChange = (mode: DrawMode) => {
    setDrawMode(mode);
    gisService.setDrawMode(mode);
    if (mode !== 'polygon')  {
      setPolygonPoints([]);
    }
    setClickedLocation(null);
  };

  const handlePolygonPointAdd = (point: [number, number]) => {
    setPolygonPoints(prev => [...prev, point]);
  };

  const handlePolygonComplete = () => {
    if (polygonPoints.length > 2) {
      onPolygonComplete([...polygonPoints, polygonPoints[0]]);
      setIsSelectActive(false);
    }
  };

  return (
    // touch-action:none — lets Leaflet own all pointer events on mobile so the browser
    // doesn't intercept pinch-zoom or pan gestures before Leaflet can handle them.
    <div className="h-full w-full" style={{ touchAction: 'none' }}>
    <MapContainer
      center={DUBAI_CENTER}
      zoom={DUBAI_ZOOM}
      className="h-full w-full rounded-lg"
      zoomControl={false}
      attributionControl={false}
      doubleClickZoom={false}
      // Mobile touch fixes:
      // touchZoom   — explicit pinch-to-zoom (default true but some iOS builds need it set)
      // tap         — disabled: Leaflet's tap emulation conflicts with iOS Safari native tap,
      //               causing missed taps and double-fires. Let the browser handle taps.
      // bounceAtZoomLimits — disabled: prevents jarring snap-back animation on mobile
      touchZoom={true}
      tap={false}
      bounceAtZoomLimits={false}
      key="map-container"
    >
      <ZoomControl position="topleft" />
      
      {clickedLocation && !clearMarker && drawMode === 'point' && (
        <Marker 
          position={clickedLocation}
          icon={drawPointMarkerIcon}
        >
          <Popup>
            <div className="text-sm">
              <strong>{t('map.selectedLocation')}</strong><br />
              {t('map.latitude')}: {clickedLocation[0].toFixed(6)}<br />
              {t('map.longitude')}: {clickedLocation[1].toFixed(6)}
            </div>
          </Popup>
        </Marker>
      )}

      {polygonPoints.length > 0 && drawMode === 'polygon' && (
        <Polygon
          positions={[...polygonPoints, polygonPoints[0]]}
          pathOptions={{
            color: 'red',
            weight: 3,
            opacity: 1,
            fillOpacity: 0.2
          }}
        />
      )}

      <MapUpdater
        locations={locations}
        selectedLocation={selectedLocation}
        isFullscreen={isFullscreen}
        isVisible={isVisible}
        clickedLocation={clickedLocation}
        onMapClick={handleMapClick}
        clearMarker={clearMarker}
        onClearGraphics={handleClearGraphics}
        isSelectActive={isSelectActive}
        onSelectToggle={handleSelectToggle}
        drawMode={drawMode}
        onDrawModeChange={handleDrawModeChange}
        onPolygonPointAdd={handlePolygonPointAdd}
        onPolygonComplete={handlePolygonComplete}
        polygonPoints={polygonPoints}
        onLocationSelect={onLocationSelect}
      />
    </MapContainer>
    </div>
  );
};

export default Map;
