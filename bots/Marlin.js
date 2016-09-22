const Promise = require('bluebird');
const _ = require('underscore');
const LineByLineReader = Promise.promisifyAll(require('line-by-line'));
const fs = require('fs');
const bsync = require('asyncawait/async');
const bwait = require('asyncawait/await');
const request = require('request-promise');

const DefaultBot = require('./DefaultBot');

function updateSubscribers(self) {
  if (Array.isArray(this.subscribers)) {
    Promise.map(this.subscribers, bsync((subscriber) => {
      const requestParams = {
        method: 'POST',
        uri: subscriber,
        body: {
          command: 'updateState',
          body: {
            event,
            bot: this.getBot(),
          },
        },
        json: true,
      };
      try {
        bwait(request(requestParams));
      } catch (ex) {
        this.logger.error(`Failed to update endpoint "${subscriber}": ${ex}`);
      }
    }, { concurrency: 5 }));
  }
}
const Marlin = function (app) {
  DefaultBot.call(this, app);

  this.status = {
    position: {
      x: undefined,
      y: undefined,
      z: undefined,
      e: undefined,
    },
    sensors: {
      t0: {
        temperature: undefined,
        setpoint: undefined,
      },
      b0: {
        temperature: undefined,
        setpoint: undefined,
      },
    },
    checkpoint: undefined,
    collaborators: {},
    blocker: {
      bot: undefined,
      checkpoint: undefined,
    },
  };

  _.extend(this.settings, {
    name: 'Marlin',
    model: __filename.split(`${__dirname}/`)[1].split('.js')[0],
  });

  _.extend(this.info, {
    connectionType: 'serial',
    vid: undefined,
    pid: undefined,
    baudrate: undefined,
    fileTypes: ['.gcode'],
  });

  _.extend(this.commands, {
    // In order to start processing a job, the job's file is opened and then
    // processed one line at a time
    startJob: bsync(function startJob(self, params) {
      const job = params.job;
      self.currentJob = job;
      self.currentJob.checkpoint = null;
      self.fsm.start();
      const filesApp = self.app.context.files;
      const theFile = filesApp.getFile(job.fileUuid);

      // open the file
      // start reading line by line...
      self.lr = new LineByLineReader(theFile.filePath);
      self.currentLine = 0;
      bwait(self.lr.pause()); // redundant

      self.lr.on('error', (err) => {
        self.logger.error('line reader error:', err);
      });

      // As the buffer reads each line, process it
      self.lr.on('line', bsync((line) => {
        // pause the line reader immediately
        // we will resume it as soon as the line is done processing
        bwait(self.lr.pause());
        // We only care about the info prior to the first semicolon
        // NOTE This code is assuming we are processing GCODE
        // In case of adding support for multiple control formats, this is a good place to start

        // Looking for a comment between 3 brackets and whatever comes after that
        const conductorComment = /^[\w\d\s]*; <<<(\w+)>>> (.*)$/;
        const conductorCommentResult = conductorComment.exec(line);
        if (conductorCommentResult !== null) {
          switch (conductorCommentResult[1]) {
            case 'CHECKPOINT': {
              const botRegex = /^.*bot(\w+) : (\d+)$/;
              const botAndCheckpoint = botRegex.exec(conductorCommentResult[2]);
              const bot = botAndCheckpoint[1];
              const checkpoint = parseInt(botAndCheckpoint[2], 10);
              self.status.checkpoint = parseInt(checkpoint, 10);
              self.logger.info(`Bot ${bot} just reached checkpoint ${checkpoint}`);
              self.lr.resume();

              if (Array.isArray(self.subscribers)) {
                for (const subscriber of self.subscribers) {
                  try {
                    const updateParams = {
                      method: 'POST',
                      uri: subscriber,
                      body: {
                        command: 'updateCollaborativeBotCheckpoint',
                        bot: self.settings.name,
                        checkpoint: self.status.checkpoint,
                      },
                    };
                    try {
                      request(updateParams);
                    } catch (ex) {
                      self.logger.error('Conductor update fail', ex);
                    }
                  } catch (ex) {
                    this.logger.error(`Failed to update endpoint "${subscriber}": ${ex}`);
                  }
                }
              }
              // Let conductor know that you've reached the latest checkpoint
              // Check if precursors are complete
              break;
            }
            case 'PRECURSOR': {
              const botRegex = /^.*(bot\w+) : (\d+)$/;
              const botAndCheckpoint = botRegex.exec(conductorCommentResult[2]);
              const bot = botAndCheckpoint[1];
              const checkpoint = parseInt(botAndCheckpoint[2], 10);
              self.status.blocker = { bot, checkpoint };
              self.logger.info(`Just set blocker to bot ${bot}, checkpoint ${checkpoint}`);
              self.commands.checkPrecursors(self);
              break;
            }
            case 'DRY': {
              // unpark?
              self.lr.resume();
              break;
            }
            default: {
              self.logger.error('Unknown comment', conductorCommentResult);
              break;
            }
          }
        } else {
          let command = line.split(';')[0];
          if (command.length <= 0) {
            // If the line is blank, move on to the next line
            bwait(self.lr.resume());
          } else {
            command = self.addOffset(command);
            command = self.addSpeedMultiplier(command);
            command = self.addFeedMultiplier(command);

            self.queue.queueCommands({
              code: command,
              postCallback: bsync(() => {
                if (self.currentJob.fsm.current === 'running') {
                  bwait(self.lr.resume());
                }
                self.currentLine += 1;
                self.currentJob.percentComplete = parseInt((self.currentLine / self.numLines) * 100, 10);
              }),
            });
          }
        }
      }));

      self.lr.on('end', bsync(() => {
        self.logger.info('completed reading file,', theFile.filePath, 'is closed now.');
        bwait(self.lr.close());
        self.queue.queueCommands({
          postCallback: bsync(() => {
            self.currentJob.percentComplete = 100;
            bwait(self.fsm.stop());
            bwait(self.fsm.stopDone());
            bwait(self.currentJob.fsm.runningDone());
            bwait(self.currentJob.stopwatch.stop());
          }),
        });
      }));

      // Get the number of lines in the file
      let numLines = 0;
      const fsPromise = new Promise((resolve, reject) => {
        fs.createReadStream(theFile.filePath)
        .on('data', function readStreamOnData(chunk) {
          numLines += chunk
          .toString('utf8')
          .split(/\r\n|[\n\r\u0085\u2028\u2029]/g)
          .length - 1;
        })
        .on('end', () => {  // done
          self.numLines = numLines;
          self.logger.info(`Bot will process file with ${self.numLines} lines.`);
          resolve();
        });
      });

      bwait(fsPromise);
      self.lr.resume();
      self.fsm.startDone();
    }),
    updateRoutine: (self, params) => {
      self.status = {
        position: {
          x: undefined,
          y: undefined,
          z: undefined,
          e: undefined,
        },
        sensors: {
          t0: {
            temperature: undefined,
            setpoint: undefined,
          },
          b0: {
            temperature: undefined,
            setpoint: undefined,
          },
        },
        checkpoint: self.status.checkpoint || undefined,
        collaborators: self.status.collaborators || {},
        blocker: self.status.blocker || {
          bot: undefined,
          checkpoint: undefined,
        },
      };

      if (self.fsm.current === 'connected') {
        const commandArray = [];
        commandArray.push({
          code: 'M114',
          processData: (command, reply) => {
            const newPosition = {
              x: undefined,
              y: undefined,
              z: undefined,
              e: undefined,
            };
            try {
              newPosition.x = Number(Number(reply.split('X:')[1].split('Y')[0]) - Number(self.settings.offsetX)).toFixed(3);
              newPosition.y = Number(Number(reply.split('Y:')[1].split('Z')[0]) - Number(self.settings.offsetY)).toFixed(3);
              newPosition.z = Number(Number(reply.split('Z:')[1].split('E')[0]) - Number(self.settings.offsetZ)).toFixed(3);
              newPosition.e = reply.split('E:')[1].split(' ')[0];
              self.status.position = newPosition;
              return true;
            } catch (ex) {
              self.logger.error('Failed to set position', reply, ex);
            }
          },
        });
        commandArray.push({
          code: 'M105',
          processData: (command, reply) => {
            self.status.sensors.t0 = {
              temperature: '?',
              setpoint: '?',
            };
            self.status.sensors.b0 = {
              temperature: '?',
              setpoint: '?',
            };

            try {
              self.status.sensors.t0.temperature = reply.split('T:')[1].split(' ')[0];
              self.status.sensors.t0.setpoint = reply.split('T:')[1].split('/')[1].split(' ')[0];
            } catch (ex) {
              // this.logger.info('Failed to parse nozzle temp');
            }

            try {
              self.status.sensors.b0.temperature = reply.split('B:')[1].split(' ')[0];
              self.status.sensors.b0.setpoint = reply.split('B:')[1].split('/')[1].split(' ')[0];
            } catch (ex) {
              // this.logger.info('Failed to parse bed temp');
            }

            self.app.io.broadcast('botEvent', {
              uuid: self.settings.uuid,
              event: 'update',
              data: self.getBot(),
            });
            return true;
          },
        });
        self.queue.queueCommands(commandArray);
      }
    },
    processGcode: bsync((self, params) => {
      const gcode = self.addOffset(params.gcode);
      if (gcode === undefined) {
        throw '"gcode" is undefined';
      }
      const commandArray = [];

      return bwait(new Promise((resolve, reject) => {
        commandArray.push(self.commands.gcodeInitialState(self, params));
        commandArray.push({
          code: gcode,
          processData: (command, reply) => {
            resolve(reply.replace('\r', ''));
            return true;
          },
        });
        commandArray.push(self.commands.gcodeFinalState(self, params));

        self.queue.queueCommands(commandArray);
      }));
    }),
    streamGcode: (self, params) => {
      if (self.queue.mQueue.length >= 32) {
        return false;
      }
      const gcode = self.addOffset(params.gcode);
      if (gcode === undefined) {
        throw '"gcode" is undefined';
      }
      const commandArray = [];
      commandArray.push(self.commands.gcodeInitialState(self, params));
      commandArray.push(gcode);
      commandArray.push(self.commands.gcodeFinalState(self, params));

      self.queue.queueCommands(commandArray);
      return true;
    },
    jog: (self, params) => {
      const commandArray = [];
      commandArray.push(self.commands.gcodeInitialState(self, params));
      commandArray.push({
        code: 'M114',
        processData: (command, reply) => {
          const currentLocation = {};
          currentLocation.x = Number(reply.split('X:')[1].split('Y')[0]);
          currentLocation.y = Number(reply.split('Y:')[1].split('Z')[0]);
          currentLocation.z = Number(reply.split('Z:')[1].split('E')[0]);
          currentLocation.e = Number(reply.split('E:')[1].split(' ')[0]);
          const newPosition = currentLocation[params.axis] + params.amount;
          let feedRate;
          if (params.feedRate) {
            feedRate = params.feedRate;
          } else {
            feedRate = self.settings[`jog${params.axis.toUpperCase()}Speed`];
          }
          let jogGcode = `G1 ${params.axis.toUpperCase()}${newPosition} F${feedRate}`;
          self.queue.prependCommands(jogGcode);
          return true;
        },
      });
      commandArray.push(self.commands.gcodeFinalState(self, params));
      self.queue.queueCommands(commandArray);
      return self.getBot();
    },
    gcodeInitialState: (self, params) => {
      let command = '';
      switch (self.fsm.current) {
        case 'connected':
          break;
        case 'processingJob':
        case 'processingJobGcode':
          command = {
            preCallback: () => {
              self.fsm.jobToGcode();
            },
          };
          break;
        case 'parked':
          command = {
            preCallback: () => {
              self.fsm.parkToGcode();
            },
          };
          break;
        default:
          throw `"processGcode" not possible from state "${self.fsm.current}`;
      }
      return command;
    },
    gcodeFinalState: (self, params) => {
      let command = '';
      switch (self.fsm.current) {
        case 'connected':
          break;
        case 'processingJob':
        case 'processingJobGcode':
          command = {
            preCallback: () => {
              self.fsm.jobGcodeDone();
            },
          };
          break;
        case 'processingParkGcode':
          command = {
            preCallback: () => {
              self.fsm.parkGcodeDone();
            },
          };
          break;
        default:
          break;
      }
      return command;
    },
    checkPrecursors: bsync(function checkPrecursors(self, params) {
      if (self.status.blocker.bot !== undefined && self.status.blocker.checkpoint !== undefined) {
        if (self.status.collaborators[self.status.blocker.bot] >= self.status.blocker.checkpoint) {
          self.lr.resume();
        }
      }
    }),
    updateCollaboratorCheckpoints: (self, params) => {
      self.status.collaborators = params.collaborators;
      self.commands.checkPrecursors(self);
    },
  });
};

module.exports = Marlin;
