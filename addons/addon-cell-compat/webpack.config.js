/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

const path = require('path');

const addonName = 'CellCompatAddon';
const mainFile = 'addon-cell-compat.js';

module.exports = {
  entry: `./out/${addonName}.js`,
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        use: ['source-map-loader'],
        enforce: 'pre',
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    modules: ['./node_modules'],
    extensions: ['.js'],
    alias: {
      common: path.resolve('../../out/common'),
      vs: path.resolve('../../out/vs')
    }
  },
  output: {
    filename: mainFile,
    path: path.resolve('./lib'),
    library: addonName,
    libraryTarget: 'umd',
    globalObject: 'globalThis'
  },
  mode: 'production'
};
