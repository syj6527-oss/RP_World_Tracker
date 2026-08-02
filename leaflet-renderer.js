// PAW MAP — MapLibre/OpenFreeMap renderer
// The legacy class name is preserved so existing UI/data code stays compatible.

import { extension_settings } from '../../../extensions.js';
import { EXTENSION_NAME } from './index.js';
import { searchPlaces } from './geo-service.js';
import { calculateRpRoute, rpRouteGeoJson } from './rp-route.js';

const STYLE_URLS = Object.freeze({
    liberty: 'https://tiles.openfreemap.org/styles/liberty',
    bright: 'https://tiles.openfreemap.org/styles/bright',
    dark: 'https://tiles.openfreemap.org/styles/dark',
});

function validCoordinate(value, min, max) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export class LeafletRenderer {
    constructor(container, lm) {
        this.container = container;
        this.lm = lm;
        this.map = null; // Legacy-compatible facade used by ui-manager.js
        this._map = null;
        this.markers = {};
        this.pathLines = [];
        this.distLabels = [];
        this.onLocationClick = null;
        this.onMoveStart = null;
        this.onMoveComplete = null;
        this.onLongPress = null;
        this.onRpRouteChange = null;
        this._movingLocId = null;
        this._selectedPinId = null;
        this._searchMarker = null;
        this._rpRoute = null;
        this._viewSet = false;
        this._styleReady = false;
    }

    _locStyle(name) {
        const lo = String(name || '').toLowerCase();
        if (/카페|cafe|coffee|커피/i.test(lo)) return { color: '#E74C3C', emoji: '☕', border: '#C0392B' };
        if (/서점|book|도서|library|서재/i.test(lo)) return { color: '#3498DB', emoji: '📚', border: '#2980B9' };
        if (/집|home|house|숙소|기숙/i.test(lo)) return { color: '#27AE60', emoji: '🏠', border: '#1E8449' };
        if (/공원|park|정원|garden|광장/i.test(lo)) return { color: '#2ECC71', emoji: '🌳', border: '#27AE60' };
        if (/문구|stationery|편의|convenience|마트|mart|가게|shop|store/i.test(lo)) return { color: '#F39C12', emoji: '🏪', border: '#D68910' };
        if (/식당|restaurant|음식|레스토랑/i.test(lo)) return { color: '#E67E22', emoji: '🍽️', border: '#CA6F1E' };
        if (/학교|school|학원|academy|university|college/i.test(lo)) return { color: '#9B59B6', emoji: '🎓', border: '#7D3C98' };
        if (/병원|hospital|의원|clinic/i.test(lo)) return { color: '#1ABC9C', emoji: '🏥', border: '#17A589' };
        if (/역|station|지하철|subway|버스|bus/i.test(lo)) return { color: '#34495E', emoji: '🚉', border: '#2C3E50' };
        if (/술집|bar|pub|tavern|주점/i.test(lo)) return { color: '#8E44AD', emoji: '🍺', border: '#6C3483' };
        if (/체육|gym|운동|fitness|arena|stadium/i.test(lo)) return { color: '#E74C3C', emoji: '🏟️', border: '#C0392B' };
        if (/성|castle|궁|palace|요새/i.test(lo)) return { color: '#7F8C8D', emoji: '🏰', border: '#616A6B' };
        if (/숲|forest|산|mountain/i.test(lo)) return { color: '#1E8449', emoji: '🌲', border: '#145A32' };
        if (/해변|beach|바다|sea|강|river|호수|lake/i.test(lo)) return { color: '#2980B9', emoji: '🌊', border: '#1F618D' };
        return { color: '#F6A93A', emoji: '📍', border: '#D68910' };
    }

    async init() {
        const gl = window.maplibregl;
        if (!gl?.Map) {
            return false;
        }

        this.container.replaceChildren();
        const mapDiv = document.createElement('div');
        mapDiv.id = 'wt-leaflet-map';
        mapDiv.style.cssText = 'width:100%;height:100%;min-height:320px;position:relative;';
        this.container.appendChild(mapDiv);

        const configuredStyle = String(extension_settings?.[EXTENSION_NAME]?.openMapStyle || 'liberty');
        const style = STYLE_URLS[configuredStyle] || STYLE_URLS.liberty;

        this._map = new gl.Map({
            container: mapDiv,
            style,
            center: [126.978, 37.5665],
            zoom: 13,
            pitch: 0,
            bearing: 0,
            attributionControl: false,
            cooperativeGestures: false,
            maxPitch: 70,
            transformRequest: url => ({ url, credentials: 'omit' }),
        });
        this._map.addControl(new gl.NavigationControl({ visualizePitch: true }), 'bottom-right');
        this._map.addControl(new gl.AttributionControl({
            compact: true,
            customAttribution: '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · © OpenStreetMap contributors',
        }), 'bottom-left');

        // Adapter for the handful of Leaflet-style calls retained in the old UI.
        this.map = {
            flyTo: ([lat, lng], zoom = 15, options = {}) => this._map?.flyTo({ center: [lng, lat], zoom, duration: Math.max(0, Number(options.duration) || 0.5) * 1000 }),
            setView: ([lat, lng], zoom = 15) => this._map?.jumpTo({ center: [lng, lat], zoom }),
            getContainer: () => this._map?.getContainer(),
            remove: () => this._map?.remove(),
        };

        this._map.on('click', event => {
            if (!this._movingLocId || !this.onMoveComplete) return;
            const locId = this._movingLocId;
            this._movingLocId = null;
            this._map.getCanvas().style.cursor = '';
            this.onMoveComplete({ lat: event.lngLat.lat, lng: event.lngLat.lng }, locId);
        });
        this._map.on('contextmenu', event => {
            event.preventDefault();
            if (this._movingLocId) {
                this._movingLocId = null;
                this._map.getCanvas().style.cursor = '';
                this.onMoveStart?.(null, '취소됨');
            }
        });
        this._installMapLongPress(mapDiv);

        return await new Promise(resolve => {
            let settled = false;
            const done = value => { if (!settled) { settled = true; resolve(value); } };
            const timer = setTimeout(() => done(false), 12000);
            this._map.once('load', () => {
                clearTimeout(timer);
                this._styleReady = true;
                this._addThreeDimensionalBuildings();
                this._syncMovementPath();
                this._syncRpRoute();
                this.render();
                done(true);
            });
            this._map.once('error', () => {
                // A tile may fail while the style still works; wait for load/timeout.
            });
        });
    }

    _installMapLongPress(mapDiv) {
        let timer = null;
        let start = null;
        const cancel = () => { if (timer) clearTimeout(timer); timer = null; start = null; };
        mapDiv.addEventListener('pointerdown', event => {
            if (event.target.closest('.wt-map-marker') || this._movingLocId) return;
            start = { x: event.clientX, y: event.clientY };
            timer = setTimeout(() => {
                timer = null;
                if (!start || !this.onLongPress || !this._map) return;
                const rect = mapDiv.getBoundingClientRect();
                const point = [start.x - rect.left, start.y - rect.top];
                const lngLat = this._map.unproject(point);
                navigator.vibrate?.(40);
                this.onLongPress(lngLat.lat, lngLat.lng);
            }, 650);
        }, { passive: true });
        mapDiv.addEventListener('pointermove', event => {
            if (!start) return;
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancel();
        }, { passive: true });
        mapDiv.addEventListener('pointerup', cancel, { passive: true });
        mapDiv.addEventListener('pointercancel', cancel, { passive: true });
    }

    _addThreeDimensionalBuildings() {
        if (!this._map || !this._styleReady || this._map.getLayer('wt-3d-buildings')) return;
        try {
            const sources = this._map.getStyle()?.sources || {};
            const sourceId = Object.keys(sources).find(id => sources[id]?.type === 'vector');
            if (!sourceId) return;
            const labelLayer = this._map.getStyle()?.layers?.find(layer => layer.type === 'symbol' && layer.layout?.['text-field']);
            this._map.addLayer({
                id: 'wt-3d-buildings',
                source: sourceId,
                'source-layer': 'building',
                type: 'fill-extrusion',
                minzoom: 15,
                paint: {
                    'fill-extrusion-color': '#d8d2c8',
                    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
                    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                    'fill-extrusion-opacity': 0.7,
                },
            }, labelLayer?.id);
        } catch (_) {
            // Some styles do not expose an OpenMapTiles building layer. 2D still works.
        }
    }

    _createMarkerElement(loc, isCurrent, isSelected) {
        const style = this._locStyle(loc.name);
        const isApproximate = loc._approximateCoordinates === true;
        const pinColor = isSelected ? '#EA4335' : isApproximate ? '#F6A93A' : isCurrent ? '#27AE60' : style.color;
        const size = isSelected ? 38 : isCurrent ? 34 : 29;
        const root = document.createElement('div');
        root.className = 'wt-map-marker';
        root.title = isApproximate ? `${loc.name} · 현재 장소 주변 추정 위치` : loc.name;
        root.style.cssText = `position:relative;width:${size}px;height:${Math.round(size * 1.35)}px;cursor:pointer;user-select:none;touch-action:none;`;

        const pin = document.createElement('div');
        pin.style.cssText = `position:absolute;left:50%;top:0;width:${size}px;height:${size}px;transform:translateX(-50%) rotate(-45deg);border-radius:50% 50% 50% 0;background:${pinColor};border:2px ${isApproximate ? 'dashed' : 'solid'} rgba(255,255,255,.96);box-shadow:0 2px 7px rgba(0,0,0,.32);box-sizing:border-box;`;
        const icon = document.createElement('span');
        icon.textContent = style.emoji;
        icon.style.cssText = `position:absolute;left:50%;top:${Math.round(size * 0.18)}px;transform:translateX(-50%);font-size:${Math.round(size * 0.39)}px;line-height:1;z-index:2;`;
        const label = document.createElement('span');
        label.textContent = `${loc.name}${loc._approximateCoordinates ? ' ≈' : ''}${isCurrent ? ' 🐾' : ''}`;
        label.style.cssText = 'position:absolute;left:50%;top:100%;transform:translate(-50%,2px);background:rgba(255,255,255,.92);color:#31343a;border:1px solid rgba(0,0,0,.12);border-radius:5px;padding:2px 5px;font-size:10px;font-weight:650;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.12);pointer-events:none;';
        root.append(pin, icon, label);

        let timer = null;
        let longPressed = false;
        const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
        root.addEventListener('pointerdown', event => {
            event.stopPropagation();
            longPressed = false;
            timer = setTimeout(() => {
                timer = null;
                longPressed = true;
                this._movingLocId = loc.id;
                this._map.getCanvas().style.cursor = 'crosshair';
                navigator.vibrate?.(40);
                this.onMoveStart?.(loc.id, loc.name);
            }, 600);
        });
        root.addEventListener('pointerup', cancel);
        root.addEventListener('pointercancel', cancel);
        root.addEventListener('pointerleave', cancel);
        root.addEventListener('click', event => {
            event.stopPropagation();
            if (longPressed) { longPressed = false; return; }
            this._selectedPinId = loc.id;
            this.render();
            this.onLocationClick?.(loc.id);
        });
        return root;
    }

    render() {
        if (!this._map || !window.maplibregl?.Marker) return;
        Object.values(this.markers).forEach(marker => marker.remove?.());
        this.markers = {};
        const coordinates = [];
        const { locations, currentLocationId } = this.lm;

        for (const loc of locations) {
            const lat = validCoordinate(loc.lat, -90, 90);
            const lng = validCoordinate(loc.lng, -180, 180);
            if (lat == null || lng == null) continue;
            const element = this._createMarkerElement(loc, loc.id === currentLocationId, loc.id === this._selectedPinId);
            const marker = new window.maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(this._map);
            marker.setLatLng = value => marker.setLngLat([Number(value.lng), Number(value.lat)]);
            marker.openPopup = () => {
                this._selectedPinId = loc.id;
                this.render();
                this.onLocationClick?.(loc.id);
            };
            this.markers[loc.id] = marker;
            coordinates.push([lng, lat]);
        }

        this._syncMovementPath();
        this._syncRpRoute();
        if (!this._viewSet && coordinates.length) {
            const current = locations.find(loc => loc.id === currentLocationId);
            if (current?.lat != null && current?.lng != null) {
                this._map.jumpTo({ center: [Number(current.lng), Number(current.lat)], zoom: 15 });
            } else if (coordinates.length === 1) {
                this._map.jumpTo({ center: coordinates[0], zoom: 15 });
            } else {
                const bounds = coordinates.reduce((box, coord) => box.extend(coord), new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
                this._map.fitBounds(bounds, { padding: 35, maxZoom: 15, duration: 0 });
            }
            this._viewSet = true;
        }
    }

    _movementGeoJson() {
        const features = [];
        for (const movement of this.lm.movements || []) {
            const from = this.lm.locations.find(loc => loc.id === movement.fromId);
            const to = this.lm.locations.find(loc => loc.id === movement.toId);
            if (!from || !to) continue;
            const values = [from.lng, from.lat, to.lng, to.lat].map(Number);
            if (!values.every(Number.isFinite)) continue;
            features.push({
                type: 'Feature',
                properties: { timestamp: Number(movement.timestamp) || 0 },
                geometry: { type: 'LineString', coordinates: [[values[0], values[1]], [values[2], values[3]]] },
            });
        }
        return { type: 'FeatureCollection', features: features.slice(-50) };
    }

    _syncMovementPath() {
        if (!this._map || !this._styleReady) return;
        const data = this._movementGeoJson();
        const source = this._map.getSource('wt-movement-path');
        if (source?.setData) {
            source.setData(data);
            return;
        }
        try {
            this._map.addSource('wt-movement-path', { type: 'geojson', data });
            this._map.addLayer({
                id: 'wt-movement-path-shadow',
                type: 'line',
                source: 'wt-movement-path',
                paint: { 'line-color': 'rgba(255,255,255,.9)', 'line-width': 5 },
            });
            this._map.addLayer({
                id: 'wt-movement-path-line',
                type: 'line',
                source: 'wt-movement-path',
                paint: { 'line-color': '#5E84E2', 'line-width': 2.2, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] },
            });
        } catch (_) {}
    }

    _recalculateRpRoute() {
        if (!this._rpRoute) return null;
        const origin = this.lm.locations.find(location => location.id === this._rpRoute.originId);
        const destination = this.lm.locations.find(location => location.id === this._rpRoute.destinationId);
        this._rpRoute = origin && destination ? calculateRpRoute(origin, destination) : null;
        return this._rpRoute;
    }

    _notifyRpRouteChange() {
        try { this.onRpRouteChange?.(this._rpRoute); } catch (_) {}
    }

    _syncRpRoute() {
        this._recalculateRpRoute();
        if (!this._map || !this._styleReady) {
            this._notifyRpRouteChange();
            return this._rpRoute;
        }
        const data = rpRouteGeoJson(this._rpRoute);
        const source = this._map.getSource('wt-rp-route');
        if (source?.setData) {
            source.setData(data);
        } else {
            try {
                this._map.addSource('wt-rp-route', { type: 'geojson', data });
                this._map.addLayer({
                    id: 'wt-rp-route-shadow',
                    type: 'line',
                    source: 'wt-rp-route',
                    paint: { 'line-color': 'rgba(255,255,255,.95)', 'line-width': 8, 'line-opacity': .95 },
                });
                this._map.addLayer({
                    id: 'wt-rp-route-line',
                    type: 'line',
                    source: 'wt-rp-route',
                    paint: { 'line-color': '#E07C3A', 'line-width': 4, 'line-opacity': .95, 'line-dasharray': [2, 1.2] },
                });
            } catch (_) {}
        }
        this._notifyRpRouteChange();
        return this._rpRoute;
    }

    showRpRoute(origin, destination) {
        const route = calculateRpRoute(origin, destination);
        if (!route) return null;
        this._rpRoute = route;
        this._syncRpRoute();
        try {
            const bounds = new window.maplibregl.LngLatBounds(route.coordinates[0], route.coordinates[0]);
            bounds.extend(route.coordinates[1]);
            this._map?.fitBounds(bounds, { padding: 70, maxZoom: 16, duration: 450 });
        } catch (_) {}
        return route;
    }

    clearRpRoute() {
        this._rpRoute = null;
        this._syncRpRoute();
    }

    refreshRpRoute() {
        return this._syncRpRoute();
    }

    startPlacing(locId) {
        this._movingLocId = locId;
        if (this._map) this._map.getCanvas().style.cursor = 'crosshair';
    }

    invalidateSize() {
        try { this._map?.resize(); } catch (_) {}
    }

    async search(query, contextHint = '') {
        const current = this.lm.locations.find(loc => loc.id === this.lm.currentLocationId);
        const bias = current?.lat != null && current?.lng != null ? { lat: current.lat, lng: current.lng } : null;
        const q = contextHint ? `${query}, ${contextHint}` : query;
        return await searchPlaces(q, { limit: 5, bias, automatic: false });
    }

    async autoGeocode(locId, name, contextHint = '') {
        const results = await searchPlaces(contextHint ? `${name}, ${contextHint}` : name, { limit: 1, automatic: true });
        const best = results[0];
        if (!best) return null;
        await this.lm.updateLocation(locId, { lat: best.lat, lng: best.lng, address: best.fullName, _approximateCoordinates: false, _approximateAnchorId: null, _tempAddress: false });
        this.render();
        return best;
    }

    showSearchResult(latValue, lngValue, name) {
        const lat = validCoordinate(latValue, -90, 90);
        const lng = validCoordinate(lngValue, -180, 180);
        if (lat == null || lng == null || !this._map) return;
        this.clearSearchMarker();
        const element = document.createElement('div');
        element.className = 'wt-map-search-marker';
        element.textContent = '⌖';
        element.title = String(name || '검색 결과');
        element.style.cssText = 'width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#EA4335;color:white;border:3px solid white;box-shadow:0 2px 10px rgba(0,0,0,.35);font-size:19px;font-weight:800;';
        this._searchMarker = new window.maplibregl.Marker({ element }).setLngLat([lng, lat]).addTo(this._map);
        this._map.flyTo({ center: [lng, lat], zoom: 15, duration: 450 });
    }

    clearSearchMarker() {
        this._searchMarker?.remove?.();
        this._searchMarker = null;
    }

    destroy() {
        this.clearSearchMarker();
        this._rpRoute = null;
        Object.values(this.markers).forEach(marker => marker.remove?.());
        this.markers = {};
        try { this._map?.remove(); } catch (_) {}
        this._map = null;
        this.map = null;
    }
}
