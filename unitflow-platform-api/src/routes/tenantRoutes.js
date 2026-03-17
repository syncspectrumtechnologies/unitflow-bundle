const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/tenantController');

const router = express.Router();
router.use(accountAuthMiddleware);
router.get('/', controller.listMine);
router.get('/:tenantId', controller.getOne);
router.put('/:tenantId/config', controller.updateConfig);
module.exports = router;
