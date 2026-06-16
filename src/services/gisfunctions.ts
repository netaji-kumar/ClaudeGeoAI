import * as L from 'leaflet';
import * as EsriLeaflet from 'esri-leaflet';
import { identifyFeatures } from 'esri-leaflet';
import proj4 from 'proj4';

interface StructuredQuery {
  type: string;
  parameters: {
    location?: string | null;
    property_type?: string | null;
    radius?: number | null;
    coordinates?: [number, number] | null;
    bounds?: L.LatLngBounds | null;
  };
}

interface GISResult {
  id: string | number;
  name?: string;
  location?: string;
  'Property Type'?: string;
  coordinates?: [number, number];
  [key: string]: any;
}

interface SpatialQueryParams {
  sourceLayerUrl: string;
  sourceField?: string;
  sourceValue?: string;
  intersectingLayerUrl?: string;
  targetField?: string;
  targetValue?: string;
  relationship?: string;
  distance?: number;
  outFields?: string[];
}

interface SingleLayerQueryParams {
  layerUrl: string;
  field: string;
  value: string;
  outFields?: string[];
}

interface NearestFeatureParams {
  sourceLayerUrl: string;
  targetLayerUrl: string;
  referencePoint: [number, number];
  distance: number;
  maxResults?: number;
  outFields?: string[];
}

interface BufferQueryParams {
  layerUrl: string;
  geometry: any;
  distance: number;
  units?: 'meters' | 'kilometers' | 'feet' | 'miles';
  outFields?: string[];
}

interface MapLayer {
  id: string;
  layer: L.Layer;
  visible: boolean;
}

type DrawMode = 'none' | 'point' | 'polygon';

interface MapState {
  center: L.LatLng;
  zoom: number;
}

interface UnifiedQueryParams {
  layerUrl?: string;
  sourceLayerUrl?: string;
  outFields?: string[];
  where?: string;
  referencePoint?: [number, number];
  distance?: number;
  units?: 'meters' | 'kilometers' | 'feet' | 'miles';
  geometry?: any;
  intersectingLayerUrl?: string;
  targetField?: string;
  targetValue?: string;
}

class GISFunctions {
  private map: L.Map | null = null;
  private layers: Map<string, MapLayer> = new Map();
  private dewaLayer: EsriLeaflet.DynamicMapLayer | null = null;
  private serviceUrl: string ;
  private readonly baseLayers: { [key: string]: L.TileLayer } = {
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
    'Satellite': L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'),
    'Terrain': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png')
  };
  private graphicsLayers: Map<string, L.Layer> = new Map();
  private isZooming: boolean = false;
  private popupLayer: L.Layer | null = null;
  private currentDrawMode: DrawMode = 'none';
  private preventZoom: boolean = false;
  private drawingLayer: L.Layer | null = null;
  private lastMapState: MapState | null = null;
  private identifyResults: any[] = [];
  private activeFeatureIndex: number = 0;
  private layerNames: Map<number, string> = new Map();
  private isMapInteracting: boolean = false;
  private clickTimeout: NodeJS.Timeout | null = null;
  private lastClickTime: number = 0;
  private readonly CLICK_DELAY = 300; // ms delay to prevent duplicate clicks

  constructor() {
    // Directly use the VITE env variable
    this.serviceUrl = import.meta.env.VITE_MAP_SERVICE_URL || 'http://localhost:5000/arcgis';
  }
  
  setMap(map: L.Map) {
    this.map = map;
    this.initializeLayers();

    if (this.lastMapState) {
      map.setView(this.lastMapState.center, this.lastMapState.zoom, { animate: false });
    }

    // Track map interaction states
    map.on('movestart', () => this.isMapInteracting = true);
    map.on('moveend', () => {
      setTimeout(() => {
        this.isMapInteracting = false;
      }, 100);
      
      if (!this.preventZoom) {
        this.lastMapState = {
          center: map.getCenter(),
          zoom: map.getZoom()
        };
      }
    });

    map.on('zoomstart', () => {
      this.isMapInteracting = true;
      this.isZooming = true;
    });

    map.on('zoomend', () => {
      setTimeout(() => {
        this.isMapInteracting = false;
        this.isZooming = false;
      }, 100);
    });

    map.on('dragstart', () => this.isMapInteracting = true);
    map.on('dragend', () => {
      setTimeout(() => {
        this.isMapInteracting = false;
      }, 100);
    });
  }

  getServiceUrl() {
    return this.serviceUrl;
  }

  setDrawMode(mode: DrawMode) {
    this.currentDrawMode = mode;
    this.preventZoom = mode !== 'none';
    
    if (this.map) {
      if (mode === 'none') {
        this.map.dragging.enable();
        this.map.doubleClickZoom.enable();
        if (this.drawingLayer) {
          this.map.removeLayer(this.drawingLayer);
          this.drawingLayer = null;
        }
      } else {
        this.map.dragging.disable();
        this.map.doubleClickZoom.disable();
      }
    }
  }

  getDrawMode(): DrawMode {
    return this.currentDrawMode;
  }

  private async initializeLayers() {
    if (!this.map) return;

    // Initialize base layers
    Object.entries(this.baseLayers).forEach(([name, layer]) => {
      if (name === 'OpenStreetMap') {
        layer.addTo(this.map!);
      }
      this.layers.set(name, {
        id: name,
        layer,
        visible: name === 'OpenStreetMap'
      });
    });

    // Initialize DEWA layer
    this.dewaLayer = EsriLeaflet.dynamicMapLayer({
      url: this.serviceUrl,
      opacity: 0.7,
      useCors: false,
	  updateInterval: 0
    }).addTo(this.map);

    this.layers.set('DEWA', {
      id: 'DEWA',
      layer: this.dewaLayer,
      visible: true
    });

    // Fetch and cache layer names
    try {
      const response = await fetch(`${this.serviceUrl}?f=json`);
      const data = await response.json();
      if (data.layers) {
        data.layers.forEach((layer: any) => {
          this.layerNames.set(layer.id, layer.name);
        });
      }
    } catch (error) {
      console.error('Error fetching layer names:', error);
    }

    // Set up identify functionality with improved click handling
    this.map.on('click', async (e: L.LeafletMouseEvent) => {
      // Ignore clicks during map interactions or draw mode
      if (this.isMapInteracting || this.currentDrawMode !== 'none') return;

      // Ignore clicks on controls
      const target = e.originalEvent.target as HTMLElement;
      if (target.closest('.leaflet-control') || target.closest('.leaflet-popup')) {
        return;
      }

      // Debounce clicks
      const currentTime = Date.now();
      if (currentTime - this.lastClickTime < this.CLICK_DELAY) {
        return;
      }
      this.lastClickTime = currentTime;

      // Clear any existing timeout
      if (this.clickTimeout) {
        clearTimeout(this.clickTimeout);
      }

      // Set new timeout for identify
      this.clickTimeout = setTimeout(async () => {
        try {
          const results = await this.identify(e.latlng);
          if (results && results.length > 0) {
            this.identifyResults = results;
            this.activeFeatureIndex = 0;
            await this.showFeaturePopup(e.latlng);
          }
        } catch (error) {
          console.error('Error in identify:', error);
        }
      }, 50);
    });
  }

  private async identify(latlng: L.LatLng) {
    if (!this.map || !this.dewaLayer || this.isMapInteracting) return [];

    const mapPoint = this.map.latLngToContainerPoint(latlng);
    const bounds = this.map.getBounds();
    const size = this.map.getSize();

    const params = {
      layers: 'all',
      tolerance: 3,
      imageDisplay: `${size.x},${size.y},96`,
      returnGeometry: true,
      mapExtent: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
      geometry: `${latlng.lng},${latlng.lat}`,
      geometryType: 'esriGeometryPoint',
      sr: 4326,
      f: 'json'
    };

    try {
      const response = await fetch(`${this.serviceUrl}/identify?${new URLSearchParams(params)}`);
      const data = await response.json();
      return data.results || [];
    } catch (error) {
      console.error('Error in identify request:', error);
      return [];
    }
  }

  private async showFeaturePopup(latlng: L.LatLng) {
    if (!this.identifyResults || !this.identifyResults.length || this.isMapInteracting) return;

    if (this.popupLayer) {
      this.map?.closePopup();
      this.popupLayer = null;
    }

    const feature = this.identifyResults[this.activeFeatureIndex];
    if (!feature) return;

    // Resolve layer name (cache → live fetch)
    let layerName = this.layerNames.get(feature.layerId) || '';
    if (!layerName) {
      try {
        const res = await fetch(`${this.serviceUrl}/${feature.layerId}?f=json`);
        const info = await res.json();
        layerName = info.name || 'Feature';
        this.layerNames.set(feature.layerId, layerName);
      } catch {
        layerName = 'Feature';
      }
    }

    const el = this.createPopupContent(
      feature.attributes,
      layerName,
      this.identifyResults.length > 1,
    );

    const popup = L.popup({
      className: 'custom-popup',
      maxWidth: 340,
      closeButton: false,
      closeOnClick: false,
      autoPan: true,
      autoPanPadding: [50, 50],
    })
      .setLatLng(latlng)
      .setContent(el);

    this.popupLayer = popup;
    popup.openOn(this.map!);
  }

  /**
   * Build a self-contained popup element: gradient header + attribute rows + optional nav.
   *
   * @param attributes  Key/value object to display (ArcGIS attributes or a Location object).
   * @param title       Header title (layer name, property name, …). Defaults to "Feature".
   * @param showNav     When true and identifyResults.length > 1, appends prev/next navigation.
   */
  private createPopupContent(
    attributes: any,
    title = 'Feature',
    showNav = false,
  ): HTMLElement {
    const SKIP_KEYS = new Set(['id', 'coordinates', 'geometryType', 'features']);

    // ── wrapper ──────────────────────────────────────────────────────────────
    const wrapper = document.createElement('div');

    // ── header ───────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'popup-header';

    const iconEl = document.createElement('div');
    iconEl.className = 'popup-header-icon';
    iconEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>`;

    const textEl = document.createElement('div');
    textEl.className = 'popup-header-text';

    const titleEl = document.createElement('div');
    titleEl.className = 'popup-header-title';
    titleEl.textContent = title;
    titleEl.title = title;
    textEl.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close-btn';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.8" stroke-linecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;
    closeBtn.onclick = () => {
      this.map?.closePopup();
      this.popupLayer = null;
    };

    header.appendChild(iconEl);
    header.appendChild(textEl);
    header.appendChild(closeBtn);
    wrapper.appendChild(header);

    // ── attribute rows ────────────────────────────────────────────────────────
    const body = document.createElement('div');
    body.className = 'popup-body';

    Object.entries(attributes).forEach(([key, value]) => {
      if (value === undefined || value === null || SKIP_KEYS.has(key)) return;

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
      body.appendChild(row);
    });

    wrapper.appendChild(body);

    // ── navigation (identify — multiple overlapping features) ─────────────────
    if (showNav && this.identifyResults.length > 1) {
      const nav = document.createElement('div');
      nav.className = 'popup-nav';

      const makeBtn = (label: string, disabled: boolean, onClick: () => void) => {
        const btn = document.createElement('button');
        btn.className = 'popup-nav-btn';
        btn.textContent = label;
        btn.disabled = disabled;
        if (!disabled) btn.onclick = onClick;
        return btn;
      };

      const prevBtn = makeBtn('← Prev', this.activeFeatureIndex === 0, () => {
        this.activeFeatureIndex--;
        this.showFeaturePopup(this.getFeatureLatLng(this.identifyResults[this.activeFeatureIndex]));
      });

      const countEl = document.createElement('span');
      countEl.className = 'popup-nav-count';
      countEl.textContent = `${this.activeFeatureIndex + 1} / ${this.identifyResults.length}`;

      const nextBtn = makeBtn('Next →', this.activeFeatureIndex >= this.identifyResults.length - 1, () => {
        this.activeFeatureIndex++;
        this.showFeaturePopup(this.getFeatureLatLng(this.identifyResults[this.activeFeatureIndex]));
      });

      nav.appendChild(prevBtn);
      nav.appendChild(countEl);
      nav.appendChild(nextBtn);
      wrapper.appendChild(nav);
    }

    return wrapper;
  }

  private getFeatureLatLng(feature: any): L.LatLng {
    const geometry = feature.geometry;
    if (geometry && geometry.x !== undefined && geometry.y !== undefined) {
      return L.latLng(geometry.y, geometry.x); // Esri format
    }

    // Fallback if it's GeoJSON
    if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
      return L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
    }

    // Default fallback
    return this.map!.getCenter();
  }

  updateLayerVisibility(layerId: number, visible: boolean) {
    if (!this.dewaLayer) return;

    const currentLayers = this.dewaLayer.getLayers() || [];
    const updatedLayers = visible 
      ? [...new Set([...currentLayers, layerId])]
      : currentLayers.filter(id => id !== layerId);

    this.dewaLayer.setLayers(updatedLayers);
  }

  resetView() {
    if (!this.map) return;
    this.map.setView([24.290349, 54.577256], 8, {
      animate: true,
      duration: 0.5
    });
  }

  private calculateFeatureBounds(features: any[]): L.LatLngBounds { 
    let bounds = L.latLngBounds([]);
    
    features.forEach(feature => {
      if (!feature.coordinates) return;

      try {
        if (feature.geometryType === 'LineString' || feature.geometryType === 'MultiLineString') {
          const latLngs: L.LatLng[] = feature.coordinates.map(
            (coord: number[]) => L.latLng(coord[1], coord[0])
          );

          latLngs.forEach(latlng => bounds.extend(latlng));

          if (latLngs.length >= 2) {
            const paddingRatio = 0.0005;
            const extended = L.latLngBounds(latLngs);
            const sw = extended.getSouthWest();
            const ne = extended.getNorthEast();

            bounds = L.latLngBounds(
              L.latLng(sw.lat - paddingRatio, sw.lng - paddingRatio),
              L.latLng(ne.lat + paddingRatio, ne.lng + paddingRatio)
            );
          }
        } else if (feature.geometryType === 'Point') {
          const coord = feature.coordinates[0];
          bounds.extend(L.latLng(coord[1], coord[0]));
        } else {
          feature.coordinates[0].forEach((coord: number[]) => {
            bounds.extend(L.latLng(coord[1], coord[0]));
          });
        }
      } catch (error) {
        console.error('Error processing coordinates:', error);
      }
    });

    if (bounds.isValid()) {
      return bounds;
    } else {
      return L.latLngBounds(
        L.latLng(25.0657, 55.1713),
        L.latLng(25.3485, 55.5741)
      );
    }
  }

  zoomToFeatures(features: any[]) {
    if (!this.map || !features.length || this.isZooming || this.preventZoom) return;

    const bounds = this.calculateFeatureBounds(features);
    if (bounds.isValid()) {
      this.map.fitBounds(bounds, {
        padding: [50, 50],
        maxZoom: 18,
        animate: true,
        duration: 0.5
      });
    }
  }

  zoomToFeature(feature: any) {
    // Intentionally NOT checking isZooming — this is a user-explicit action
    // (row click) and must always fire, even if an auto-zoom is in progress.
    if (!this.map || !feature?.coordinates || this.preventZoom) return;

    if (this.popupLayer) {
      this.map.closePopup();
      this.popupLayer = null;
    }

    const bounds = this.calculateFeatureBounds([feature]);
    if (bounds.isValid()) {
      // Stop any in-progress animation (e.g. auto zoomToFeatures on data load)
      // before flying to this individual feature. Without this, the first row
      // click is silently blocked when the initial zoom-to-all animation is running.
      this.map.stop();

      this.map.flyToBounds(bounds, {
        padding: [50, 50],
        maxZoom: 18,
        duration: 0.5
      });

      // Open popup after the flyToBounds animation finishes (~600 ms)
      setTimeout(() => {
        if (!this.map || !feature.coordinates) return;

        // Derive a meaningful title from well-known name fields
        const title: string =
          feature.Property_Name ||
          feature.Property_ID  ||
          feature.Name         ||
          feature.name         ||
          feature.OBJECTID     ||
          'Feature';

        const popupContent = this.createPopupContent(feature, String(title));

        const popup = L.popup({
          closeButton: false,
          closeOnClick: false,
          className: 'custom-popup'
        })
        .setLatLng(bounds.getCenter())
        .setContent(popupContent);

        this.popupLayer = popup;
        popup.openOn(this.map);
      }, 600);
    }
  }

  clearGraphics() {
    if (!this.map) return;

    if (this.popupLayer) {
      this.map.closePopup();
      this.popupLayer = null;
    }

    if (this.drawingLayer) {
      this.map.removeLayer(this.drawingLayer);
      this.drawingLayer = null;
    }

    // Only remove explicitly tracked graphics layers — NOT all markers/polygons.
    // Result markers/polygons are managed by Map.tsx layersRef; the eachLayer sweep
    // was removing background cluster layer icons as a side effect.
    this.graphicsLayers.forEach(layer => {
      if (this.map!.hasLayer(layer)) {
        this.map!.removeLayer(layer);
      }
    });
    this.graphicsLayers.clear();

    this.setDrawMode('none');
    this.preventZoom = false;
  }

  async executeQuery(structuredQuery: StructuredQuery): Promise<GISResult[]> {
    try {
      let query = this.buildQuery(structuredQuery);
      let results = await this.executeFeatureQuery(query);
      return this.processResults(results);
    } catch (error) {
      console.error('Error executing GIS query:', error);
      throw error;
    }
  }

  async querySingleLayer(params: SingleLayerQueryParams): Promise<GISResult[]> {
    try {
      if (!params.layerUrl) {
        throw new Error("Layer URL is required");
      }

      const layerMetadata = await fetch(`${params.layerUrl}?f=json`)
        .then(response => response.json())
        .then(data => data.name);

      const layer = EsriLeaflet.featureLayer({
        url: params.layerUrl
      });

      let allFeatures: any[] = [];
      let offset = 0;
      const limit = 2000;
      let hasMore = true;

      while (hasMore) {
        const featureCollection = await new Promise<any>((resolve, reject) => {
          const query = layer.query();
          if (params.field != "" || params.value != "") {
            query.where(`UPPER(${params.field}) LIKE UPPER('%${params.value}%')`);
          }
          else {
            query.where(`1=1`);
          }
          if (params.outFields) {
            query.fields(params.outFields);
          }

          query.offset(offset).limit(limit);

          query.run((error: any, fc: any) => {
            if (error) reject(error);
            else resolve(fc);
          });
        });

        if (!featureCollection || !featureCollection.features.length) {
          break;
        }

        allFeatures = [...allFeatures, ...featureCollection.features];
        hasMore = featureCollection.features.length === limit;
        offset += limit;
      }

      if (!allFeatures.length) {
        return [];
      }

      const processedResults = allFeatures.map((feature: any, index: number) => {
        let coordinates;
        if (feature.geometry.type === 'Point') {
          coordinates = [[feature.geometry.coordinates]];
        } else if (feature.geometry.type === 'Polygon') {
          coordinates = [feature.geometry.coordinates[0]];
        } else if (feature.geometry.type === 'MultiPolygon') {
          coordinates = feature.geometry.coordinates[0];
        } else if (feature.geometry.type === 'LineString') {
          coordinates = feature.geometry.coordinates;
        }
        return {
          id: feature.id || index + 1,
          ...feature.properties,
          coordinates: coordinates,
          geometryType: feature.geometry.type
        };
      });

      return [{
        message: `Found ${processedResults.length} feature(s)`,
        description: `${processedResults.length} features found matching "${params.value}" in ${params.field} from layer "${layerMetadata}"`,
        features: allFeatures,
        attributes: processedResults
      }];
    } catch (error) {
      console.error("Error querying single layer:", error);
      throw error;
    }
  }

  async findNearestFeatures(params: NearestFeatureParams): Promise<GISResult[]> {
    try {
      if (!params.sourceLayerUrl || !params.targetLayerUrl || !params.referencePoint || !params.distance) {
        throw new Error("Source layer URL, target layer URL, reference point, and distance are required");
      }

      const referenceLatLng = L.latLng(params.referencePoint[0], params.referencePoint[1]);
      const bufferRadius = params.distance;

      const targetLayer = EsriLeaflet.featureLayer({
        url: params.targetLayerUrl
      });

      const featureCollection = await new Promise<any>((resolve, reject) => {
        const query = targetLayer.query()
          .nearby(referenceLatLng, bufferRadius);

        if (params.outFields) {
          query.fields(params.outFields);
        }

        if (params.maxResults) {
          query.limit(params.maxResults);
        }

        query.run((error: any, fc: any) => {
          if (error) reject(error);
          else resolve(fc);
        });
      });

      if (!featureCollection || !featureCollection.features.length) {
        return [];
      }

      const featuresWithDistance = featureCollection.features.map((feature: any) => {
        let featurePoint;
        if (feature.geometry.type === 'Point') {
          featurePoint = L.latLng(feature.geometry.coordinates[0], feature.geometry.coordinates[1]);
        } else {
          const bounds = L.geoJSON(feature).getBounds();
          featurePoint = bounds.getCenter();
        }
        
        const distance = referenceLatLng.distanceTo(featurePoint);
        return { ...feature, distance };
      }).sort((a: any, b: any) => a.distance - b.distance);

      const processedResults = featuresWithDistance.map((feature: any, index: number) => {
        let coordinates;
        if (feature.geometry.type === 'Point') {
          coordinates = [[feature.geometry.coordinates]];
        } else if (feature.geometry.type === 'Polygon') {
          coordinates = [feature.geometry.coordinates[0]];
        } else if (feature.geometry.type === 'MultiPolygon') {
          coordinates = feature.geometry.coordinates[0];
        }

        return {
          id: feature.id || index + 1,
          ...feature.properties,
          distance: Math.round(feature.distance),
          coordinates: coordinates,
          geometryType: feature.geometry.type
        };
      });

      return [{
        message: `Found ${processedResults.length} nearby feature(s)`,
        description: `${processedResults.length} features found within ${params.distance}m of the reference point`,
        features: featuresWithDistance,
        attributes: processedResults
      }];
    } catch (error) {
      console.error("Error finding nearest features:", error);
      throw error;
    }
  }

  async queryBuffer(params: BufferQueryParams): Promise<GISResult[]> {
    try {
      if (!params.layerUrl || !params.geometry || !params.distance) {
        throw new Error("Layer URL, geometry, and distance are required");
      }

      const layer = EsriLeaflet.featureLayer({
        url: params.layerUrl
      });

      const layerMetadata = await fetch(`${params.layerUrl}?f=json`)
        .then(response => response.json())
        .then(data => data.name);

      let distanceInMeters = params.distance;
      switch (params.units) {
        case 'kilometers':
          distanceInMeters = params.distance * 1000;
          break;
        case 'feet':
          distanceInMeters = params.distance * 0.3048;
          break;
        case 'miles':
          distanceInMeters = params.distance * 1609.34;
          break;
      }

      const featureCollection = await new Promise<any>((resolve, reject) => {
        const query = layer.query();

        if (params.outFields) {
          query.fields(params.outFields);
        }

        if (params.geometry.type === 'Point') {
          const point = L.latLng(params.geometry.coordinates[0], params.geometry.coordinates[1]);
          query.nearby(point, distanceInMeters);
        } else {
          const geojsonPolygon = {
            type: "Polygon",
            coordinates: [params.geometry.coordinates[0].map(coord => [coord[1], coord[0]])]
          };

          query.intersects(geojsonPolygon);
        }

        query.run((error: any, fc: any) => {
          if (error) reject(error);
          else resolve(fc);
        });
      });

      if (!featureCollection || !featureCollection.features.length) {
        return [];
      }

      const processedResults = featureCollection.features.map((feature: any, index: number) => {
        let coordinates;
        if (feature.geometry.type === 'Point') {
          coordinates =[[feature.geometry.coordinates]];
        } else if (feature.geometry.type === 'Polygon') {
          coordinates = [feature.geometry.coordinates[0]];
        } else if (feature.geometry.type === 'MultiPolygon') {
          coordinates = feature.geometry.coordinates[0];
        }

        return {
          id: feature.id || index + 1,
          ...feature.properties,
          coordinates: coordinates,
          geometryType: feature.geometry.type
        };
      });

      return [{
        message: `Found ${processedResults.length} feature(s)`,
        description: `${processedResults.length} ${layerMetadata} features found within a ${params.distance} ${params.units || 'm'} buffer from the selected location`,
        features: featureCollection.features,
        attributes: processedResults
      }];
    } catch (error) {
      console.error("Error querying buffer:", error);
      throw error;
    }
  }

  async queryFeatureLayer(params: SpatialQueryParams): Promise<GISResult[]> {
    try {
      let results: GISResult[] = [];

      if (!params.sourceLayerUrl) {
        throw new Error("Source layer URL is required.");
      }

      const sourceLayer = EsriLeaflet.featureLayer({ url: params.sourceLayerUrl });
      let allFeatures: any[] = [];
      let offset = 0;
      const limit = 2000;
      let hasMore = true;

      if (params.intersectingLayerUrl) {
        const intersectingLayer = EsriLeaflet.featureLayer({ url: params.intersectingLayerUrl });
        const intersectingFeatures = await new Promise<any>((resolve, reject) => {
          intersectingLayer.query()
            .where(`${params.targetField} = '${params.targetValue}'`)
            .run((error: any, fc: any) => {
              if (error) reject(error);
              else resolve(fc);
            });
        });

        if (!intersectingFeatures.features.length) {
          return results;
        }

        const targetGeometries = intersectingFeatures.features[0].geometry;

        while (hasMore) {
          let sourceQuery = sourceLayer.query()
            .intersects(targetGeometries)
            .offset(offset)
            .limit(limit);

          if (params.sourceField && params.sourceValue) {
            sourceQuery = sourceQuery.where(`UPPER(${params.sourceField}) LIKE UPPER('%${params.sourceValue}%')`);
          }
          if (params.outFields) {
            sourceQuery.fields(params.outFields);
          }

          const featureCollection = await new Promise<any>((resolve, reject) => {
            sourceQuery.run((error: any, fc: any) => {
              if (error) reject(error);
              else resolve(fc);
            });
          });

          if (!featureCollection || !featureCollection.features.length) {
            break;
          }

          allFeatures = [...allFeatures, ...featureCollection.features];
          hasMore = featureCollection.features.length === limit;
          offset += limit;
        }
      } else {
        while (hasMore) {
          let sourceQuery = sourceLayer.query()
            .offset(offset)
            .limit(limit);

          if (params.sourceField && params.sourceValue) {
            sourceQuery = sourceQuery.where(`UPPER(${params.sourceField}) LIKE UPPER('%${params.sourceValue}%')`);
          }

          const featureCollection = await new Promise<any>((resolve, reject) => {
            sourceQuery.run((error: any, fc: any) => {
              if (error) reject(error);
              else resolve(fc);
            });
          });

          if (!featureCollection || !featureCollection.features.length) {
            break;
          }

          allFeatures = [...allFeatures, ...featureCollection.features];
          hasMore = featureCollection.features.length === limit;
          offset += limit;
        }
      }

      if (!allFeatures.length) {
        return results;
      }

      const processedResults = allFeatures.map((feature: any, index: number) => {
        let coordinates;
        if (feature.geometry.type === 'Point') {
          coordinates = [[feature.geometry.coordinates]];
        } else if (feature.geometry.type === 'Polygon') {
          coordinates = [feature.geometry.coordinates[0]];
        } else if (feature.geometry.type === 'MultiPolygon') {
          coordinates = feature.geometry.coordinates[0];
        }

        const properties = feature.properties;
        let fieldName = params.targetField;
        const orderedAttributes: any = {
          [fieldName]: params.targetValue,
          id: feature.id || index + 1,
          coordinates: coordinates,
          geometryType: feature.geometry.type
        };

        for (const key in properties) {
          orderedAttributes[key] = properties[key];
        }

        return orderedAttributes;
      });

      results.push({
        message: `Found ${processedResults.length} feature(s)`,
        description: `${processedResults.length} features found in ${params.targetValue || 'search area'}`,
        features: allFeatures,
        attributes: processedResults
      });

      return results;
    } catch (error) {
      console.error("Error executing GIS query:", error);
      throw error;
    }
  }
  
	async runGISQuery(structuredUrl: string): Promise<GISResult[]> {
  try {
    const response = await fetch(structuredUrl);
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

    const data = await response.json();
    const features = data.features || [];
    const allFeatures: any[] = [];

    // Helper to infer geometry type
    const detectGeometryType = (geometry: any): string => {
      if (!geometry) return 'unknown';
      if (geometry.x !== undefined && geometry.y !== undefined) return 'Point';
      if ('rings' in geometry) return 'Polygon';
      if ('paths' in geometry) return 'Polyline';
      return 'unknown';
    };

    // Coordinate builder
    const buildCoordinates = (geometry: any): any => {
      if (!geometry) return [];
	  
	  const utmZone40N = '+proj=utm +zone=40 +datum=WGS84 +units=m +no_defs';
	const wgs84 = 'EPSG:4326';

	// Transform
	const [lon, lat] = [geometry.x, geometry.y]; // proj4(utmZone40N, wgs84, [geometry.x, geometry.y]);

      if (geometry.x !== undefined && geometry.y !== undefined) {
        return [[lon,lat]]; // Wrap in [[...]] to match your format
      }

      if ('rings' in geometry) {
        return [geometry.rings[0]]; // Simplify polygon
      }

      if ('paths' in geometry) {
        return geometry.paths[0]; // Line
      }

      return [];
    };

/*     for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const geometry = f.geometry;
	  console.error(geometry);
	  console.error(i);
      const geometryType = detectGeometryType(geometry);
      const coordinates = buildCoordinates(geometry);

      allFeatures.push({
        id: f.attributes?.OBJECTID || i + 1,
        ...f.attributes,
        coordinates,
        geometryType
      });
    } */
	
	for (let i = 0; i < features.length; i++) {
	  const f = features[i];
	  const geometry = f.geometry;
	  const geometryType = detectGeometryType(geometry);

	  let coordinates = null;

	  if (geometry?.x !== undefined && geometry?.y !== undefined) {
		const x = Number(geometry.x);
		const y = Number(geometry.y);

		if (Number.isFinite(x) && Number.isFinite(y)) {
			coordinates = buildCoordinates(geometry)
		} else {
		  console.warn("Skipping invalid coordinates:", geometry, f);
		  coordinates = [ x, y ];
		  //continue; // skip this feature
		}
	  } else {
		console.warn("Missing geometry:", f);
		continue;
	  }

	  allFeatures.push({
		id: f.attributes?.OBJECTID || i + 1,
		...f.attributes,
		coordinates,
		geometryType
	  });
	}

    // Parse the 'where' clause from URL for metadata
    const urlParams = new URLSearchParams(structuredUrl.split('?')[1]);
    const whereClause = urlParams.get("where") || 'N/A';

    return [{
      message: `Found ${allFeatures.length} feature(s)`,
      description: `${allFeatures.length} feature(s) matching condition: ${whereClause}`,
      features,
      attributes: allFeatures
    }];
  } catch (error) {
    console.error("Error in runGISQuery:", error);
    throw error;
  }
}


private buildCoordinates(geometry: any): any {
  if (!geometry) return null;
  if (geometry.x !== undefined && geometry.y !== undefined) {
    return [geometry.x, geometry.y]; // ✅ Point as [x, y]
  }
  if ('rings' in geometry) {
    return geometry.rings; // ✅ Polygon
  }
  if ('paths' in geometry) {
    return geometry.paths; // ✅ Polyline
  }
  return geometry;
}

  async runGISQueryWithParams(params: UnifiedQueryParams): Promise<GISResult[]> {
    try {
      const layerUrl = params.layerUrl || params.sourceLayerUrl;
      const outFields = params.outFields || ['*'];
      const whereClause = params.where || '1=1';
      const layer = EsriLeaflet.featureLayer({ url: layerUrl });
      const layerName = await fetch(`${layerUrl}?f=json`).then(res => res.json()).then(data => data.name);

      const allFeatures: any[] = [];

      const buildCoordinates = (feature: any) => {
        switch (feature.geometry.type) {
          case 'Point': return [[feature.geometry.coordinates]];
          case 'Polygon': return [feature.geometry.coordinates[0]];
          case 'MultiPolygon': return feature.geometry.coordinates[0];
          case 'LineString': return feature.geometry.coordinates;
          default: return [];
        }
      };

      const runQuery = (query: any): Promise<any> =>
        new Promise((resolve, reject) => query.run((err: any, fc: any) => err ? reject(err) : resolve(fc)));

      const paginateQuery = async (query: any) => {
        const limit = 2000;
        let offset = 0;
        let hasMore = true;
        const results: any[] = [];

        while (hasMore) {
          const paginated = query.offset(offset).limit(limit);
          const fc = await runQuery(paginated);
          if (!fc.features.length) break;
          results.push(...fc.features);
          hasMore = fc.features.length === limit;
          offset += limit;
        }

        return results;
      };

      // 🔹 Nearest Feature Query
      if (params.referencePoint) {
        const point = L.latLng(params.referencePoint[0], params.referencePoint[1]);
        const query = layer.query().nearby(point, params.distance).fields(outFields).where(whereClause);
        const fc = await runQuery(query);

        const features = fc.features.map((f: any) => {
          const center = f.geometry.type === 'Point'
            ? L.latLng(f.geometry.coordinates[0], f.geometry.coordinates[1])
            : L.geoJSON(f).getBounds().getCenter();
          return { ...f, distance: point.distanceTo(center) };
        }).sort((a, b) => a.distance - b.distance);

        const attributes = features.map((f, i) => ({
          id: f.id || i + 1,
          ...f.properties,
          distance: Math.round(f.distance),
          coordinates: buildCoordinates(f),
          geometryType: f.geometry.type
        }));

        return [{
          message: `Found ${attributes.length} nearby feature(s)`,
          description: `${attributes.length} features within ${params.distance}m of reference point`,
          features,
          attributes
        }];
      }

      // 🔹 Buffer Query
      if (params.geometry && !params.intersectingLayerUrl) {
        let dist = params.distance;
        if (isNaN(dist)) dist = 0;
        if (params.units === 'kilometers') dist *= 1000;
        else if (params.units === 'miles') dist *= 1609.34;
        else if (params.units === 'feet') dist *= 0.3048;

        const query = layer.query().fields(outFields).where(whereClause);

        if (params.geometry.type === 'Point') {
          query.nearby(L.latLng(params.geometry.coordinates[0], params.geometry.coordinates[1]), dist);
        } else {
          const polygon = {
            type: "Polygon",
            coordinates: [params.geometry.coordinates[0].map(([x, y]: number[]) => [y, x])]
          };
          query.intersects(polygon);
        }

        const features = await paginateQuery(query);
        const attributes = features.map((f: any, i: number) => ({
          id: f.id || i + 1,
          ...f.properties,
          coordinates: buildCoordinates(f),
          geometryType: f.geometry.type
        }));

        return [{
          message: `Found ${attributes.length} feature(s)`,
          description: `${attributes.length} ${layerName} features within ${dist} ${params.units || 'm'}`,
          features: features,
          attributes
        }];
      }

      // 🔹 Intersect Query
      if (params.intersectingLayerUrl && params.targetField && params.targetValue) {
        const intersectLayer = EsriLeaflet.featureLayer({ url: params.intersectingLayerUrl });
        const intersectFc = await runQuery(
          intersectLayer.query().where(`${params.targetField} = '${params.targetValue}'`)
        );

        if (!intersectFc.features.length) return [];
        const geom = intersectFc.features[0].geometry;

        const query = layer.query().intersects(geom).fields(outFields).where(whereClause);
        const features = await paginateQuery(query);

        const attributes = features.map((f: any, i: number) => ({
          id: f.id || i + 1,
          ...f.properties,
          coordinates: buildCoordinates(f),
          geometryType: f.geometry.type
        }));

        return [{
          message: `Found ${attributes.length} feature(s)`,
          description: `${attributes.length} features in ${params.targetValue}`,
          features,
          attributes
        }];
      }

      // 🔹 Single Layer Query
      const query = layer.query().fields(outFields).where(whereClause);
      const features = await paginateQuery(query);

      const attributes = features.map((f: any, i: number) => ({
        id: f.id || i + 1,
        ...f.properties,
        coordinates: buildCoordinates(f),
        geometryType: f.geometry.type
      }));

      return [{
        message: `Found ${attributes.length} feature(s)`,
        description: `${attributes.length} feature(s) matching condition: ${whereClause}`,
        features,
        attributes
      }];
    } catch (error) {
      console.error("Error in runGISQuery:", error);
      throw error;
    }
  }

  private buildQuery(structuredQuery: StructuredQuery): any {
    let query = L.esri.query({
      url: `${this.serviceUrl}/0`
    });

    let whereClause = '1=1';
    
    if (structuredQuery.parameters.property_type) {
      whereClause += ` AND PropertyType = '${structuredQuery.parameters.property_type}'`;
    }
    
    if (structuredQuery.parameters.location) {
      whereClause += ` AND Location = '${structuredQuery.parameters.location}'`;
    }

    query.where(whereClause);

    if (structuredQuery.parameters.coordinates && structuredQuery.parameters.radius) {
      const point = L.latLng(structuredQuery.parameters.coordinates[0], structuredQuery.parameters.coordinates[1]);
      query.within(point, structuredQuery.parameters.radius);
    }

    if (structuredQuery.parameters.bounds) {
      query.within(structuredQuery.parameters.bounds);
    }

    return query;
  }

  private async executeFeatureQuery(query: any): Promise<any[]> {
    return new Promise((resolve, reject) => {
      query.run((error: Error | null, featureCollection: any) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(featureCollection.features);
      });
    });
  }

  private processResults(features: any[]): GISResult[] {
    return features.map(feature => ({
      id: feature.id || Math.random().toString(36).substr(2, 9),
      name: feature.properties.Name,
      location: feature.properties.Location,
      'Property Type': feature.properties.PropertyType,
      coordinates: feature.geometry.type === 'Point' 
        ? [feature.geometry.coordinates[1], feature.geometry.coordinates[0]]
        : undefined,
      geometryType: feature.geometry.type,
      ...feature.properties
    }));
  }
}

export const gisService = new GISFunctions();