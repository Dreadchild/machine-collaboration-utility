import React from 'react';
import Modal from 'react-bootstrap-modal';
import request from 'superagent';

import File from './file';

export default class Files extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      showModal: false,
    };
    this.handleProcessFile = this.handleProcessFile.bind(this);
    this.close = this.close.bind(this);
    this.startJob = this.startJob.bind(this);
  }

  handleProcessFile(fileInfo) {
    this.setState({
      showModal: true,
      fileUuid: fileInfo.uuid,
      fileName: fileInfo.name,
    });
  }

  close() {
    this.setState({ showModal: false });
  }

  createBotList() {
    const options = Object.entries(this.props.botPresets).map(([presetKey, preset]) => {
      return <option key={presetKey} value={presetKey}>{preset.settings.name}</option>;
    });
    options.push(<option key={-1} value={`Conductor`}>Conductor</option>);
    return (
      <select name="botList" form="newJobForm">
        {options}
      </select>
    );
  }

  renderModal() {
    return (
    <Modal show={this.state.showModal} onHide={this.close}>
      <Modal.Header closeButton>
        <Modal.Title>Modal heading</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div>{this.state.fileUuid}</div>
        <div>{this.state.fileName}</div>
        {this.createBotList()}
        <button onClick={this.startJob}>Start Job</button>
      </Modal.Body>
      <Modal.Footer>
        <button onClick={this.close}>Close</button>
      </Modal.Footer>
    </Modal>
    );
  }

  startJob() {
    // Create a job
    const requestParams = {
      fileUuid: this.state.fileUuid,
      botId: -1,
      startJob: true,
    };

    request.post(`/v1/jobs`)
    .send(requestParams)
    .set('Accept', 'application/json')
    .end();
    this.close();
  }

  render() {
    const files = Object.entries(this.props.files).map(([fileKey, file]) => {
      return <File key={file.uuid} file={file} handleProcessFile={this.handleProcessFile}/>;
    });
    return (<div>
      {this.renderModal()}
      <h1>Files</h1>
      <button onClick={this.props.dropzoneOpener}>Upload File</button>
      <br></br>
      <br></br>
      <div>{files}</div>
    </div>);
  }
}
