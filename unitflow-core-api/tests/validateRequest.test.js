const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../src/middlewares/validateRequest');

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.payload = body;
        resolve({ statusCode: this.statusCode, body });
      }
    };
    middleware(req, res, () => resolve({ statusCode: 200, body: null }));
  });
}

test('request validation rejects malformed payloads', async () => {
  const middleware = validate({
    body: {
      email: { required: true, type: 'email' },
      amount: { required: true, type: 'number', min: 1 }
    }
  });

  const result = await runMiddleware(middleware, { body: { email: 'bad-email', amount: 0 } });
  assert.equal(result.statusCode, 400);
  assert.equal(Array.isArray(result.body.errors), true);
  assert.equal(result.body.errors.length >= 2, true);
});
