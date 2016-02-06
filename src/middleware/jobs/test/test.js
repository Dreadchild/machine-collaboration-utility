/* global describe, it */
const should = require(`should`);
const request = require(`request-promise`);
const fs = require(`fs-promise`);
const path = require(`path`);

module.exports = function toDoListTests() {
  let nJobs;
  let job;
  describe('Jobs unit test', function () {
    it('should create a job', async function (done) {
      const requestParams = {
        method: `POST`,
        uri: `http://localhost:9000/v1/jobs/`,
        json: true,
      };
      job = await request(requestParams);
      should(!!job.id);
      should(!!job.state);
      done();
    });
    it('should have a job state of "created"', async function (done) {
      // TODO instead of referring to the job object, query the job again from the API
      should(job.state === `created`);
      done();
    });
    it('should retreive an array of existing jobs', async function (done) {
      const requestParams = {
        method: `GET`,
        uri: `http://localhost:9000/v1/jobs/`,
        json: true,
      };
      const jobs = await request(requestParams);
      should(Array.isArray(jobs)).equal(true);
      nJobs = jobs.length;
      done();
    });
    it('should assign a file to a job', async function (done) {
      // Upload a file
      const testFilePath = path.join(__dirname, `blah.txt`);
      const file = await fs.createReadStream(testFilePath);
      const formData = { file };
      const fileUploadParams = {
        method: `POST`,
        uri: `http://localhost:9000/v1/files`,
        formData,
      };
      const uploadResponse = JSON.parse(await request(fileUploadParams));
      const fileId = uploadResponse[0].id;

      const requestParams = {
        method: `POST`,
        uri: `http://localhost:9000/v1/jobs/${job.id}/setFile`,
        body: { fileId },
        json: true,
      };
      job = await request(requestParams);
      should(!!job.id);
      should(!!job.fileId);
      should(job.state).equal(`ready`);
      done();
    });
  });
};