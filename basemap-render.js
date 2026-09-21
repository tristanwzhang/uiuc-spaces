// ─── Basemap tile drawing ─────────────────────────────────────────────────────
// Shared by the background worker (basemap-worker.js) and the main page (used
// only if the browser can't draw in a worker). No Cesium or DOM needed here.

const BasemapRender = (() => {
  const EARTH_RADIUS = 6378137;
  const TILE_SIZE = 512;
  const mercX = lon => EARTH_RADIUS * lon * Math.PI / 180;
  const mercY = lat => EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

  /** Decode data/basemap.json into Web Mercator metres plus a grid index. */
  function buildIndex(basemap, area) {
    const [west, south] = basemap.bounds;
    const features = [];
    for (const [layerIndex, ...rings] of basemap.features) {
      const decoded = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ring of rings) {
        const pts = new Float64Array(ring.length);
        let x = 0, y = 0;
        for (let i = 0; i < ring.length; i += 2) {
          x += ring[i]; y += ring[i + 1];
          const mx = mercX(west + x / basemap.scale);
          const my = mercY(south + y / basemap.scale);
          pts[i] = mx; pts[i + 1] = my;
          if (mx < minX) minX = mx; if (mx > maxX) maxX = mx;
          if (my < minY) minY = my; if (my > maxY) maxY = my;
        }
        decoded.push(pts);
      }
      features.push({ layer: basemap.layers[layerIndex], rings: decoded, minX, minY, maxX, maxY });
    }

    const index = {
      features,
      layers: basemap.layers,
      gridN: 64,
      gx0: mercX(area.west), gx1: mercX(area.east),
      gy0: mercY(area.south), gy1: mercY(area.north),
      seen: new Uint32Array(features.length),
      stamp: 0,
    };
    index.grid = Array.from({ length: index.gridN * index.gridN }, () => []);
    features.forEach((f, id) => {
      const [c0, r0, c1, r1] = cells(index, f.minX, f.minY, f.maxX, f.maxY);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) index.grid[r * index.gridN + c].push(id);
    });
    return index;
  }

  function cells(index, x0, y0, x1, y1) {
    const n = index.gridN;
    const cx = x => Math.min(n - 1, Math.max(0, Math.floor((x - index.gx0) / (index.gx1 - index.gx0) * n)));
    const cy = y => Math.min(n - 1, Math.max(0, Math.floor((y - index.gy0) / (index.gy1 - index.gy0) * n)));
    return [cx(x0), cy(y0), cx(x1), cy(y1)];
  }

  /**
   * Draw one tile onto `canvas` (DOM canvas or OffscreenCanvas, TILE_SIZE²).
   * `tile` is the tile's Web Mercator rectangle {west, south, east, north}.
   * `flipY`: draw upside down. Needed for ImageBitmaps — the map flips canvas
   * images when uploading them but expects bitmaps to arrive already flipped.
   */
  function drawTile(ctx, index, style, tile, level, flipY = false) {
    const size = TILE_SIZE;
    const scale = size / (tile.east - tile.west);   // px per metre
    if (flipY) ctx.setTransform(1, 0, 0, -1, 0, size);
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, size, size);

    const pad = 20 / scale;
    const [c0, r0, c1, r1] = cells(index, tile.west - pad, tile.south - pad, tile.east + pad, tile.north + pad);
    const stamp = ++index.stamp;
    const byLayer = {};
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const id of index.grid[r * index.gridN + c]) {
          if (index.seen[id] === stamp) continue;
          index.seen[id] = stamp;
          const f = index.features[id];
          if (f.maxX < tile.west - pad || f.minX > tile.east + pad ||
              f.maxY < tile.south - pad || f.minY > tile.north + pad) continue;
          (byLayer[f.layer] ||= []).push(f);
        }
      }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const layer of index.layers) {
      const s = style[layer];
      const list = byLayer[layer];
      if (!s || !list || level < (s.minLevel ?? 0)) continue;

      const trace = (f) => {
        for (const pts of f.rings) {
          for (let i = 0; i < pts.length; i += 2) {
            const px = (pts[i] - tile.west) * scale;
            const py = (tile.north - pts[i + 1]) * scale;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
        }
      };

      if (s.fill) {
        // Each area is filled on its own: overlapping areas (a park containing
        // lawns) must not cancel each other out. Even-odd only applies to an
        // area's own rings, so its holes stay holes.
        ctx.fillStyle = s.fill;
        for (const f of list) {
          ctx.beginPath();
          trace(f);
          ctx.fill('evenodd');
        }
      } else {
        ctx.beginPath();
        for (const f of list) trace(f);
        ctx.strokeStyle = s.stroke;
        ctx.lineWidth = Math.max(s.widthM * scale, s.minPx);
        ctx.setLineDash(s.dash && level >= 14 ? s.dash : []);
        ctx.stroke();
      }
    }
  }

  return { TILE_SIZE, buildIndex, drawTile };
})();
