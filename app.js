'use strict';

const TOKEN_ENDPOINT       = 'https://accounts.artik.cloud/token',
	  ARTIK_CLOUD_ENDPOINT = 'https://api.artik.cloud/v1.1';

var get      = require('lodash.get'),
	async    = require('async'),
	request  = require('request'),
	platform = require('./platform'),
	isEmpty  = require('lodash.isempty'),
	config;

let processDeviceData = function (data, callback) {
	async.each(data, (data, cb) => {
		platform.requestDeviceInfo(data.sdid, function (error, requestId) {
			if (error) return cb(error);

			platform.once(requestId, function (deviceInfo) {
				if (!deviceInfo)
					return cb(new Error(`Device ${data.sdid} not registered`));

				platform.processData(data.sdid, JSON.stringify(data), cb);
			});
		});
	}, callback);
};

/**
 * Emitted when the platform issues a sync request. Means that the stream plugin should fetch device data from the 3rd party service.
 * @param {date} lastSyncDate Timestamp from when the last sync happened. Allows you to fetch data from a certain point in time.
 */
platform.on('sync', function (lastSyncDate) {
	let startDate = new Date(lastSyncDate).getTime();
	let endDate = Date.now();

	async.waterfall([
		(done) => {
			request.post({
				url: TOKEN_ENDPOINT,
				headers: {
					'content-type': 'application/x-www-form-urlencoded'
				},
				form: {
					grant_type: 'client_credentials'
				},
				json: true,
				auth: {
					user: config.client_id,
					pass: config.client_secret
				}
			}, (error, response, body) => {
				if (error)
					done(error);
				else if (body.error || response.statusCode !== 200)
					done(new Error(body.error.message || body.error));
				else if (isEmpty(body.access_token))
					done(new Error('Invalid Credentials. No access token was received.'));
				else
					done(null, body.access_token);
			});
		},
		(token, done) => {
			let devices = [];
			let hasMoreResults = true;
			let offset = 0;

			async.whilst(() => {
				return hasMoreResults;
			}, (cb) => {
				request({
					url: `${ARTIK_CLOUD_ENDPOINT}/users/${config.user_id}/devices?offset=${100 * offset}&count=100`,
					json: true,
					auth: {
						bearer: token
					}
				}, (error, response, body) => {
					if (error)
						cb(error);
					else if (body.error || response.statusCode !== 200)
						done(new Error(body.error.message || body.error));
					else {
						let devicesTmp = get(body, 'data.devices');

						if (isEmpty(devicesTmp)) {
							hasMoreResults = false;
							return cb();
						}

						offset++;

						async.map(devicesTmp, (device, next) => {
							next(null, device.id);
						}, (mapError, devicesIds) => {
							devices = devices.concat(devicesIds);
							cb();
						});
					}
				});
			}, (err) => {
				done(err, token, devices);
			});
		},
		(token, devices, done) => {
			async.each(devices, (device, cb) => {
				request({
					url: `${ARTIK_CLOUD_ENDPOINT}/messages?count=100&startDate=${startDate}&endDate=${endDate}&sdid=${device}`,
					json: true,
					auth: {
						bearer: token
					}
				}, (error, response, body) => {
					if (error)
						cb(error);
					else if (body.error || response.statusCode !== 200)
						done(new Error(body.error.message || body.error));
					else {
						let data = get(body, 'data');

						if (isEmpty(data))
							cb();
						else
							processDeviceData(data, cb);
					}
				});
			}, done);
		}
	], (error) => {
		if (error) platform.handleException(error);
	});
});

/**
 * Emitted when the platform shuts down the plugin. The Stream should perform cleanup of the resources on this event.
 */
platform.once('close', function () {
	platform.notifyClose();
});

/**
 * Emitted when the platform bootstraps the plugin. The plugin should listen once and execute its init process.
 * Afterwards, platform.notifyReady() should be called to notify the platform that the init process is done.
 * @param {object} options The parameters or options. Specified through config.json.
 */
platform.once('ready', function (options) {
	config = options;
	platform.notifyReady();
	platform.log('Artik Stream has been initialized.');
});