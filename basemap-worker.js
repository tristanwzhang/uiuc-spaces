// Draws basemap tiles in the background so dragging the map never waits on it.
// Messages in:  {type: 'init', url, style, area}
//               {type: 'tile', id, level, tile: {west, south, east, north}}
// Messages out: {type: 'tile', id, bitmap}   or   {type: 'error', id, message}

importScripts('basemap-render.js' + self.location.search);

let index = null;
let style = null;
const waiting = [];

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    style = msg.style;
    try {
      const basemap = await (await fetch(msg.url)).json();
      index = BasemapRender.buildIndex(basemap, msg.area);
      self.postMessage({ type: 'ready' });
      while (waiting.length) draw(waiting.shift());
    } catch (e) {
      self.postMessage({ type: 'failed', message: String(e) });
    }
  } else if (msg.type === 'tile') {
    if (index) draw(msg); else waiting.push(msg);
  }
};

function draw({ id, level, tile }) {
  try {
    const size = BasemapRender.TILE_SIZE;
    const canvas = new OffscreenCanvas(size, size);
    BasemapRender.drawTile(canvas.getContext('2d'), index, style, tile, level, true);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ type: 'tile', id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ type: 'error', id, message: String(e) });
  }
}
