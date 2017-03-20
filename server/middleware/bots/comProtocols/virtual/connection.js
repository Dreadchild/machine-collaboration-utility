/*******************************************************************************
 * FakeMarlinConnection.js
 *
 * A class to manage opening, maintaining, and closing a serial connection.
 * This class wraps a serialport connection and mostly cleanly handles the data
 * stream following open so that we settle into a clean state to match commands
 * with responses.
 ******************************************************************************/
const _ = require('underscore');
const Promise = require('bluebird');
const bsync = require('asyncawait/async');
const bwait = require('asyncawait/await');
let logger;

/**
 * VirtualConnection()
 *
 * Simulates responses generated by Marlin Firmware
 *
 * User defined callbacks can be set for processing data, close and error
 *
 * Args:   inComName       - name of our com port
 *         inBaud          - baud rate
 *         inOpenPrimeStr  - string of commands to prime the connection
 *         inInitDataFunc  - passed opening sequence data (inInitDataFunc(inData))
 *         inConnectedFunc - function to call when we have successfully
 *                           connected
 * Return: N/A
 */
var VirtualConnection = function(app, connectedFunc) {
  this.app = app;
  this.logger = app.context.logger;
  this.mCloseFunc = undefined;
  this.mErrorFunc = undefined;
  this.mDataFunc = connectedFunc;

  this.nBufferedCommands = 0;
  this.bufferSize = 32;

  connectedFunc(this);
};


/*******************************************************************************
 * Public interface
 *******************************************************************************/

/**
 * setDataFunc(), setCloseFunc, setErrorFunc()
 *
 * Set the user configurable functions to call when we receive data,
 * close the port or have an error on the port.
 */
VirtualConnection.prototype.setDataFunc = function setDataFunc(inDataFunc) {
  this.mDataFunc = inDataFunc;
};
VirtualConnection.prototype.setCloseFunc = function setCloseFunc(inCloseFunc) {
  this.mCloseFunc = inCloseFunc;
};
VirtualConnection.prototype.setErrorFunc = function setErrorFunc(inErrorFunc) {
  this.mErrorFunc = inErrorFunc;
};

/**
 * send()
 *
 * Send a command to the device
 *
 * Args:   inCommandStr - string to send
 * Return: N/A
 */
VirtualConnection.prototype.send = bsync(function send(inCommandStr) {
  if (_.isFunction(this.mDataFunc)) {
    const commandPrefix = inCommandStr.split(' ').shift();
    let reply = 'ok';
    if (this.nBufferedCommands >= this.bufferSize) {
      bwait(this.waitForBufferToClear());
    }
    this.nBufferedCommands++;
    switch (commandPrefix) {
      case 'G4':
        if (inCommandStr.indexOf('G4 P') !== -1) {
          bwait(Promise.delay(parseInt(inCommandStr.split('G4 P').pop().split('\n').shift(), 10)));
        }
        reply = 'ok';
        break;
      case 'G1':
        bwait(Promise.delay(100));
        reply = 'ok';
        break;
      default:
        this.logger.error('command not supported');
    }
    this.nBufferedCommands--;
    this.mDataFunc(reply);
    // this.app.io.emit('botReply', reply);
  }
});

/**
 * close()
 *
 * Close our connection
 *
 * Args:   N/A
 * Return: N/A
 */
VirtualConnection.prototype.close = function close() {
  if (_.isFunction(this.mCloseFunc)) {
    this.mCloseFunc();
  }
};

VirtualConnection.prototype.waitForBufferToClear = bsync(function waitForBufferToClear() {
  bwait(Promise.delay(100));
  if (this.nBufferedCommands >= this.bufferSize) {
    bwait(this.waitForBufferToClear());
  }
});

module.exports = VirtualConnection;
