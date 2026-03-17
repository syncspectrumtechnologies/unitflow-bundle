const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/trialController');

const router = express.Router();
router.post('/start', accountAuthMiddleware, controller.startTrial);
module.exports = router;
