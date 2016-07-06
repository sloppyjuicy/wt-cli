'use strict';

var url = require('url');
var _ = require('lodash');
var coroutine = require('bluebird').coroutine;
var Chalk = require('chalk');
var Cli = require('structured-cli');
var ConfigFile = require('../lib/config');

module.exports = Cli.createCommand('mv', {
    description: 'Move a named webtask',
    plugins: [
        require('./_plugins/profile'),
    ],
    options: {
        'target-container': {
            description: 'Target container',
            type: 'string',
            dest: 'targetContainer'
        },
        'target-profile': {
            description: 'Target profile',
            type: 'string',
            dest: 'targetProfile'
        },
    },
    params: {
        'source': {
            description: 'Source webtask name',
            type: 'string',
            required: true,
        },
        'target': {
            description: 'Target webtask name',
            type: 'string',
            required: false,
        },
    },
    handler: handleWebtaskMove,
});

function handleWebtaskMove(args) {
    var options = _(args).pick(['targetContainer', 'targetProfile']).omitBy(_.isNull).value();
    var targetName = args.target || args.source;

    return moveWebtask(args.profile, args.source, {
        profile: options.targetProfile,
        container: options.targetContainer,
        name: targetName
    }).then(function() {
        console.log(Chalk.green('Moved webtask: %s'), Chalk.bold(targetName));
    });
}

function moveWebtask(profile, name, target) {

    if (equal({
            name: name,
            container: profile.container,
            profile: profile.name
        }, target)) {
        throw Cli.error.invalid('Webtasks are identical. Use a different target name, container or profile.');
    }

    return read(profile, name)
        .then(function(claims) {
            return copy(profile, claims, target);
        })
        .then(function() {
            return profile.removeWebtask({
                name: name
            });
        });
}

function equal(sourceParams, targetParams) {
    return _.isEqual(sourceParams, {
        name: targetParams.name,
        container: targetParams.container || sourceParams.container,
        profile: targetParams.profile || sourceParams.profile
    });
}

function read(profile, name) {
    return profile.inspectWebtask({
            name: name,
            decrypt: true,
            fetch_code: true
        })
        .catch(function(err) {
            if (err.statusCode === 404) {
                throw Cli.error.notFound('No such webtask: ' + Chalk.bold(name));
            }
            throw err;
        });
}

function copy(profile, claims, target) {
    if (!claims.jtn) {
        throw Cli.error.cancelled('Not a named webtask.');
    }

    var targetClaims = _(claims).omit(['jti', 'iat', 'ca']).value();
    if (url.parse(claims.url).protocol === 'webtask:') {
        delete targetClaims.url;
    } else {
        delete targetClaims.code;
    }
    targetClaims.jtn = target.name || targetClaims.jtn;
    targetClaims.ten = target.container || targetClaims.ten;

    var pendingCreate;
    if (target.profile) {
        pendingCreate = loadProfile(target.profile)
            .then(function(profile) {
                target.profile = profile;
                targetClaims.ten = target.container || profile.container || targetClaims.ten;
                return target.profile.createRaw(targetClaims);
            });
    } else {
        target.profile = profile;
        pendingCreate = target.profile.createRaw(targetClaims);
    }

    return pendingCreate
        .then(function() {
            return profile.getWebtask({
                name: claims.jtn
            });
        })
        .then(function(webtask) {
            target.name = targetClaims.jtn;
            return moveCronJob(profile, claims.jtn, target, {
                verify: webtask.token
            });
        })
        .then(function() {
            return copyStorage(profile, claims.jtn, target);
        })
        .catch(function(err) {
            throw Cli.error.cancelled('Failed to create webtask. ' + err);
        });
}

function loadProfile(name) {
    var config = new ConfigFile();

    return config.getProfile(name);
}

function moveCronJob(profile, name, target, options) {
    return coroutine(function*() {
        var job;

        try {
            job = yield profile.getCronJob({
                name: name
            });
        } catch (err) {
            if (err.statusCode === 404) {
                return;
            }
            throw err;
        }

        let webtask = yield profile.getWebtask({
            name: target.name
        });

        if (job.token !== _.get(options, 'verify')) {
            throw Cli.error.cancelled('Failed to verify the cron job token (no match).');
        }

        yield target.profile.createCronJob({
            name: target.name,
            container: target.container,
            token: webtask.token,
            schedule: job.schedule
        });

        yield profile.removeCronJob({
            name: name
        });
    })();
}

// TODO: copy built-in data
function copyStorage(profile, name, target) {
    console.log('copyStorage: profile=%j, name=%j, target=%j', profile, name, target); // TODO: remove
}