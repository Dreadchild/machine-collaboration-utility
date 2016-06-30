const DefaultBot = require(`./DefaultBot`);

module.exports = class SmoothieBoard extends DefaultBot {
  constructor(app) {
    super(app);
    this.settings.name = `Smoothie Board`;
    this.settings.model = `SmoothieBoardConductor`;
    this.connectionType = `telnet`;
  }
};
