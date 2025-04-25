// backend/utils/nodeCanvasFactory.js
const { createCanvas } = require('canvas');

class NodeCanvasFactory {
  create(width, height) {
    const canvas  = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(cc, width, height) {
    cc.canvas.width  = width;
    cc.canvas.height = height;
  }
  destroy(cc) {
    cc.canvas.width  = 0;
    cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

module.exports = NodeCanvasFactory;