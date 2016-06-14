var request = require('request')
var debug = {
    log: require('debug')('re'),
    http: require('debug')('re.http'),
    metrics: require('debug')('re.metrics')
}
var async = require('async')
var promclient = require('prometheus-client')

process.on('SIGINT', function() {
    debug.log('Received SIGINT - shutting down')
    process.exit(1);
});

var opts = getOptions()
createServer(opts.cattle_config_url, opts.listen_port, opts.update_interval, opts.monitor_state)

function getOptions() {
    var opts = {
        // required
        cattle_access_key:  process.env.CATTLE_ACCESS_KEY,
        cattle_secret_key:  process.env.CATTLE_SECRET_KEY,

        // optional
        cattle_config_url:  process.env.CATTLE_CONFIG_URL || 'http://localhost:8080/v1',
        listen_port:        process.env.LISTEN_PORT || 9010,
        update_interval:    process.env.UPDATE_INTERVAL || 5000,
        monitor_state:      process.env.MONITOR_STATE || 'state'
    }

    var requiredOpts = [
        'CATTLE_ACCESS_KEY',
        'CATTLE_SECRET_KEY'
    ]
    requiredOpts.forEach(function(name) {
        if (!opts[name.toLowerCase()]) {
            throw new Error('Missing environment variable for option: ' + name)
            process.exit(1)
        }
    })

    return opts
}

function createServer(cattle_config_url, listen_port, update_interval, monitor_state) {
    var client = new promclient()

    var environment_gauge = client.newGauge({
        namespace: 'rancher',
        name: 'environment',
        help: 'Value of 1 if all containers in a stack are active or healthy'
    })

    var services_gauge = client.newGauge({
        namespace: 'rancher',
        name: 'services',
        help: 'Value of 1 if individual services in a stack are active or healthy'
    })

    var hosts_gauge = client.newGauge({
        namespace: 'rancher',
        name: 'hosts',
        help: 'Value of 1 if individual hosts are active or healthy'
    })

    function updateGauge(gauge_name, params, value) {
        gauge_name.set(params, value)
    }

    function updateMetrics() {
        debug.log('requesting metrics')
        getEnvironmentsState(cattle_config_url, monitor_state, function(err, results, servicedata, hostdata) {
            if (err) {
                debug.log('failed to get environment state: %s', err.toString())
                throw err
            }
            debug.log('got stack metric results %o', results)
            Object.keys(results).forEach(function(name) {
                var stateOrHealthState = results[name]
                var envName = getSafeName(name)
                if (monitor_state == 'healthState') {                  
                  var value = (stateOrHealthState == 'healthy') ? 1 : 0
                } else {
                  var value = (stateOrHealthState == 'active') ? 1 : 0
                }
                updateGauge(environment_gauge, { name: envName }, value)
            });
            debug.log('got service metric results %o', servicedata)
            servicedata.map( function(item) {
                var serviceName = getSafeName(item.name)
                var envName = getSafeName(item.environment)
                var envServname = envName + "/" + serviceName
                if (monitor_state == 'healthState') {                  
                  var value = (item.healthState == 'healthy') ? 1 : 0
                } else {
                  var value = (item.state == 'active') ? 1 : 0
                }
                updateGauge(services_gauge, { name: envServname }, value)
            });
            debug.log('got host metric results %o', hostdata)
            hostdata.map( function(item) {
                var hostName = (item.name != null) ? getSafeName(item.name) : getSafeName(item.hostname)
                var value = (item.state == 'active') ? 1 : 0
                updateGauge(hosts_gauge, { name: hostName }, value)
            });

        });
    }

    client.listen(listen_port)
    debug.log('listening on %s', listen_port)

    updateMetrics()
    setInterval(updateMetrics, update_interval)
}

function getSafeName(name) {
    return name.replace(/[^a-zA-Z0-9_:]/g, '_')
}

function getEnvironmentsState(cattle_config_url, monitor_state, callback) {
    var envIdMap = {}
    var hostIdMap = {}

    async.waterfall([
        function(next) {
            var uri = cattle_config_url + '/projects'
            jsonRequest(uri, function(err, json) {
                debug.log('got json results %o', json.data)
                if (err) {
                    return next(err)
                }
                if (Array.isArray(json.data) &&
                    json.data[0] &&
                    json.data[0].links &&
                    json.data[0].links.hosts &&
                    json.data[0].links.environments
                ) {
                    var environments = json.data[0].links.environments
                    var hosts = json.data[0].links.hosts
                    return next(null, environments, hosts)
                }
                debug.log('Missing data from API: %o', json)
                return next(new Error('Missing data from API: ' + json.toString()))
            })
        },
        function(environmentsUrl, hostsUrl, next) {
            jsonRequest(environmentsUrl, function(err, json) {
                if (err) {
                    return next(err)
                }
                var servicesUrl = json.data.map(function(raw) {
                    return raw.links.services
                });
                json.data.forEach(function(env) {
                    envIdMap[env.id] = env.name
                });
                next(null, servicesUrl, hostsUrl)
            });
        },
        function(servicesUrl, hostsUrl, next) {
            jsonRequest(hostsUrl, function(err, json) {
                if (err) {
                    return next(err)
                }
                var hostsData = json.data.map(function(raw) {
                    return {
                        name: raw.name,
                        state: raw.state,
                        hostname: raw.hostname,
                        labels: raw.labels
                    }
                });
                next(null, servicesUrl, hostsData)
            });
        },
        function(servicesUrls, hostsData, next) {
            var tasks = servicesUrls.map(function(servicesUrl) {
                return function(next) {
                    jsonRequest(servicesUrl, next)
                }
            });

            async.parallel(tasks, function(err, results) {
                var data = results.map(function(servicesRaw) {
                    return servicesRaw.data
                });

                next(null, data, hostsData)
            });
        },
        function(servicesData, hostsData, next) {
            var services = servicesData.map(function(stackServices) {
                return stackServices.map(function(service) {
                    return {
                        name: service.name,
                        state: service.state,
                        healthState: service.healthState,
                        environment: envIdMap[service.environmentId]
                    }
                });
            });

            var flattened = []
            services.forEach(function(service) {
                flattened = flattened.concat(service)
            });

            var hostflattened = []
            hostsData.forEach(function(cattle_config_url) {
                hostflattened = hostflattened.concat(cattle_config_url)
            });

            next(null, flattened, hostflattened)
        },
        function(serviceData, hostData, next) {
            var envState = {}
            serviceData.forEach(function(service) {
                if (!envState[service.environment]) {
                    envState[service.environment] = (monitor_state == 'healthState') ? service.healthState: service.state
                } else if (monitor_state == 'healthState' && service.healthState != 'healthy') {
                    envState[service.environment] = service.healthState
                } else if (service.state != 'active') {
                    envState[service.environment] = service.state
                }
            });
            next(null, envState, serviceData, hostData)
        }
    ], function(err, results, serviceData, hostData) {
        callback(err, results, serviceData, hostData)
    })
}

function getRequestId() {
    return Math.floor(Math.random() * 100000000000000)
}

function jsonRequest(uri, callback) {
    var requestId = getRequestId()
    debug.http('send request %s: %s', requestId, uri)

    request({
        uri: uri,
        headers: {
            'Accept': 'application/json'
        },
        auth: {
            user: opts.cattle_access_key,
            pass: opts.cattle_secret_key,
            sendImmediately: true
        }
    }, function(err, response, body) {
        if (err) {
            debug.http('got error response: %s', err.toString())
            return callback(err)
        }

        debug.http('got response for %s with code %s', requestId, response.statusCode)

        var data;
        try {
            data = JSON.parse(body)
        } catch(e) {
            debug.http('Failed to JSON decode response body')
            var error = new Error('json decode')
            error.response = response
            error.body = body
            return callback(error)
        }

        return callback(null, data)
    })
}
