/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var crypto = require('crypto');
var MemoryStream = require('stream').PassThrough;
var obj = require('../../lib/obj');
var path = require('path');
var util = require('util');
var uuid = require('node-uuid');


if (require.cache[path.join(__dirname, '/../helper.js')])
    delete require.cache[path.join(__dirname, '/../helper.js')];
var testHelper = require('../helper.js');


///--- Globals

var sprintf = util.format;

var MIN_UPLOAD_SIZE = 0;
var MAX_TEST_UPLOAD_SIZE = 1000;

var MIN_NUM_COPIES = obj.DEF_MIN_COPIES;
var MAX_NUM_COPIES = obj.DEF_MAX_COPIES;

var MIN_PART_NUM = 0;
var MAX_PART_NUM = 9999;

var ZERO_BYTE_MD5 = obj.ZERO_BYTE_MD5;

var TEXT = 'The lazy brown fox \nsomething \nsomething foo';
var TEXT_MD5 = crypto.createHash('md5').update(TEXT).digest('base64');


///--- Helpers

/*
 * All MPU-related tests should use this in the test setup code, and the
 * complimentary cleanupMPUTester function in the test teardown code.
 *
 * This function sets up some helper methods on the tester object that provide
 * are cleaned up properly.  Specifically, when an upload is created, the
 * `uploadId` field is set to the MPU's upload ID. If it is finalized using
 * the helper methods {abort,commit}Upload, the `uploadFinalized` flag is set.
 * On teardown, we use these flags to ensure all uploads are finalized so that
 * they will be garbage collected.
 */
function initMPUTester(tcb) {
    var self = this;

    self.client = testHelper.createClient();
    self.userClient = testHelper.createUserClient('muskie_test_user');

    self.uploadsRoot = '/' + self.client.user + '/uploads';
    self.root = '/' + self.client.user + '/stor';
    self.dir = self.root + '/' + uuid.v4();
    self.path = self.dir + '/' + uuid.v4();

    self.uploadId = null;
    self.partsDirectory = null;
    self.uploadFinalized = false;

    // Thin wrappers around the MPU API.
    self.createUpload = function create(p, headers, cb) {
        createUploadHelper.call(self, p, headers, false, cb);
    };
    self.abortUpload = function abort(id, cb) {
        abortUploadHelper.call(self, id, false, cb);
    };
    self.commitUpload = function commit(id, etags, cb) {
        commitUploadHelper.call(self, id, etags, false, cb);
    };
    self.getUpload = function get(id, cb) {
        getUploadHelper.call(self, id, false, cb);
    };
    self.writeTestObject = function writeObject(id, partNum, cb) {
        writeObjectHelper.call(self, id, partNum, TEXT, false, cb);
    };

    // Wrappers using subusers as the caller.
    self.createUploadSubuser = function createSubuser(p, headers, cb) {
        createUploadHelper.call(self, p, headers, true, cb);
    };
    self.abortUploadSubuser = function abortSubuser(id, cb) {
        abortUploadHelper.call(self, id, true, cb);
    };
    self.commitUploadSubuser = function commitSubuser(id, etags, cb) {
        commitUploadHelper.call(self, id, etags, true, cb);
    };
    self.getUploadSubuser = function getSubuser(id, cb) {
        getUploadHelper.call(self, id, true, cb);
    };
    self.writeTestObjectSubuser = function writeObjectSubuser(id, partNum, cb) {
        writeObjectHelper.call(self, id, partNum, TEXT, true, cb);
    };

   /*
    * Returns the path a client can use to get redirected to the real
    * partsDirectory of a created MPU.
    *
    * Inputs:
    * - pn: optional part num to include in the path
    */
    self.redirectPath = function redirectPath(pn) {
        assert.ok(self.uploadId);
        var p = self.uploadsRoot + '/' + self.uploadId;
        if (typeof (pn) === 'number') {
            p += '/' + pn;
        }
        return (p);
    };

   /*
    * Returns the partsDirectory of a created MPU.
    *
    * Inputs:
    * - pn: optional part num to include in the path
    */
    self.uploadPath = function uploadPath(pn) {
        assert.ok(self.partsDirectory);
        var p = self.partsDirectory;
        if (typeof (pn) === 'number') {
            p += '/' + pn;
        }
        return (p);
    };

    self.client.mkdir(self.dir, function (mkdir_err) {
        if (mkdir_err) {
            tcb(mkdir_err);
        } else {
            tcb(null);
        }
    });
}

/*
 * All MPU-related tests should use this in the test teardown code, and the
 * complimentary initMPUTester function in the test setup code.
 *
 * This function ensures that if an upload was created and not finalized by the
 * test, it is aborted, so that the MPU can be garbage collected. It also
 * closes open clients and removes test objects created as a part of the test.
 */
function cleanupMPUTester(cb) {
    var self = this;
    function closeClients(ccb) {
        this.client.close();
        this.userClient.close();
        ccb();
    }

    self.client.rmr(self.dir, function () {
        if (self.uploadId && !self.uploadFinalized) {
            var opts = {
                account: self.client.user
            };
            self.client.abortUpload(self.uploadId, opts,
                closeClients.bind(self, cb));
        } else {
            closeClients.call(self, cb);
        }
    });
}


/*
 * Helper that creates an upload and passes the object returned from `create`
 * to the callback. On success, it will do a basic sanity check on the object
 * returned by create using the tester.
 *
 * Parameters:
 *  - p: the target object path to pass to `create`
 *  - h: a headers object to pass to `create`
 *  - subuser: bool representing whether to try with a subuser
 *  - cb: callback of the form cb(err, object)
 */
function createUploadHelper(p, h, subuser, cb) {
    var self = this;
    assert.object(self);
    assert.func(cb);

    var opts = {
        headers: {
            'content-type': 'application/json',
            'expect': 'application/json'
        },
        path: self.uploadsRoot
    };

    var client = self.client;
    if (subuser) {
        client = self.userClient;
    }

    client.signRequest({
        headers: opts.headers
    }, function (err) {
        if (err) {
            cb(err);
        } else {
            var body = {};
            if (p) {
                body.objectPath = p;
            }
            if (h) {
                body.headers = h;
            }

            self.client.jsonClient.post(opts, body,
            function (err2, req, res, o) {
                if (err2) {
                    cb(err2);
                } else {
                    self.uploadId = o.id;
                    self.partsDirectory = o.partsDirectory;
                    var err3 = checkCreateResponse(o);
                    if (err3) {
                        cb(err2);
                    } else {
                        cb(null, o);
                    }
                }
            });
        }
    });
}

/*
 * Helper that gets a created upload and passes the object returned
 * to the callback. On success, it will do a basic sanity check on the object
 * returned.
 *
 * Parameters:
 *  - id: the upload ID to `get`
 *  - subuser: bool representing whether to try with a subuser
 *  - cb: callback of the form cb(err, upload)
 */
function getUploadHelper(id, subuser, cb) {
    var self = this;
    assert.object(self);
    assert.string(id);
    assert.bool(subuser);
    assert.func(cb);

    var client = self.client;
    if (subuser) {
        client = self.userClient;
    }

    var opts = {
        account: self.client.user
    };

    client.getUpload(id, opts, function (err, upload) {
        if (err) {
            cb(err);
        } else {
            var err2 = checkGetResponse.call(self, upload);
            if (err2) {
                cb(err2);
            } else {
                cb(null, upload);
            }
        }
    });
}

/*
 * Helper that aborts an MPU and sets the `uploadFinalized` flag on the tester
 * object.
 *
 * Parameters:
 *  - id: the upload ID
 *  - subuser: bool representing whether to try with a subuser
 *  - cb: callback of the form cb(err)
 */
function abortUploadHelper(id, subuser, cb) {
    var self = this;
    assert.object(self);
    assert.string(id);
    assert.bool(subuser);
    assert.func(cb);

    var client = self.client;
    if (subuser) {
        client = self.userClient;
    }

    var opts = {
        account: self.client.user
    };

    client.abortUpload(id, opts, function (err) {
        if (err) {
            cb(err);
        } else {
            self.uploadFinalized = true;
            cb();
        }
    });
}


/*
 * Helper that commits an MPU and sets the `uploadFinalized` flag on the tester
 * object.
 *
 * Parameters:
 *  - id: the upload ID
 *  - etags: an array of etags representing parts to commit
 *  - subuser: bool representing whether to try with a subuser
 *  - cb: callback of the form cb(err)
 */
function commitUploadHelper(id, etags, subuser, cb) {
    var self = this;
    assert.object(self);
    assert.string(id);
    assert.bool(subuser);
    assert.func(cb);

    var client = self.client;
    if (subuser) {
        client = self.userClient;
    }

    var opts = {
        account: self.client.user
    };

    client.commitUpload(id, etags, opts, function (err) {
        if (err) {
            cb(err);
        } else {
            self.uploadFinalized = true;
            cb();
        }
    });
}


/*
 * Uploads a test object to an upload.
 *
 * Parameters:
 *  - id: the upload ID
 *  - partNum: the part number
 *  - string: string representing the object data
 *  - subuser: bool representing whether to try with a subuser
 *  - cb: callback of the form cb(err, res)
 */
function writeObjectHelper(id, partNum, string, subuser, cb) {
    var self = this;
    assert.object(self);
    assert.string(string);

    var client = self.client;
    if (subuser) {
        client = self.userClient;
    }

    var opts = {
        account: self.client.user,
        md5: crypto.createHash('md5').update(string).digest('base64'),
        size: Buffer.byteLength(string),
        type: 'text/plain'
    };

    var stream = new MemoryStream();
    client.put(self.uploadPath(partNum), stream, opts, cb);
    setImmediate(stream.end.bind(stream, string));
}


function ifErr(t, err, desc) {
    t.ifError(err, desc);
    if (err) {
        t.deepEqual(err.body, {}, desc + ': error body');
        return (true);
    }

    return (false);
}

function between(min, max) {
    return (Math.floor(Math.random() * (max - min + 1) + min));
}

function randomPartNum() {
    return (between(MIN_PART_NUM, MAX_PART_NUM));
}

function randomUploadSize() {
    return (between(MIN_UPLOAD_SIZE, MAX_TEST_UPLOAD_SIZE));
}

function randomNumCopies() {
    return (between(MIN_NUM_COPIES, 3));
}


// Given an array of etags, returns the md5 we expect from the MPU API.
function computePartsMD5(parts) {
    var hash = crypto.createHash('md5');
    parts.forEach(function (p) {
        hash.update(p);
    });

    return (hash.digest('base64'));
}


/*
 * Verifies that the response sent by muskie on create-mpu is correct. If it's
 * not, we return an error.
 *
 * Inputs:
 *  - o: the object returned from create-mpu
 */
function checkCreateResponse(o) {
    if (!o) {
        return (new Error('create-mpu returned no response'));
    }

    if (!o.id) {
        return (new Error('create-mpu did not return an upload ID'));
    }

    if (!o.partsDirectory) {
        return (new Error('create-mpu did not return a parts directory'));
    }

    if (!(o.id === path.basename(o.partsDirectory))) {
        return (new Error('create-mpu returned an upload ID that does not ' +
            'match its parts directory'));
    }

    return (null);
}

/*
 * Verifies that the response sent by muskie on get-mpu is correct. If anything
 * is wrong, we return an error.
 *
 * Inputs:
 *  - u: the object returned from get-mpu
 */
function checkGetResponse(u) {
    if (!u) {
        return (new Error('get-mpu returned no response'));
    }

    if (!u.id) {
        return (new Error('get-mpu did not return an upload ID'));
    }

    // Verify that the id from create-mpu matches what get-mpu said.
    if (this.uploadId) {
        if (this.uploadId !== u.id) {
            return (new Error(sprintf('get-mpu returned an upload with a ' +
                'different id than was returned from create-mpu: ' +
                'expected id "%s", but got id "%s"',
                this.uploadId, u.id)));
        }

        if (u.state === 'created') {
            if (this.partsDirectory !== u.partsDirectory) {
                return (new Error(sprintf('get-mpu returned an upload with a ' +
                    'different partsDirectory than was returned from ' +
                    'create-mpu: expected partsDirectory "%s", but got "%s"',
                    this.partsDirectory, u.partsDirectory)));
            }
        }
    }

    if (!u.state) {
        return (new Error('get-mpu did not return an upload state'));
    }

    if (!(u.state === 'created' || u.state === 'finalizing' ||
       u.state === 'done')) {
        return (new Error(sprintf('get-mpu returned an invalid state: %s',
            u.state)));
    }

    if (!u.targetObject) {
        return (new Error('get-mpu did not return the target object path'));
    }

    if (!u.headers) {
        return (new Error('get-mpu did not return the target object headers'));
    }

    if (!u.numCopies) {
        return (new Error('get-mpu did not return numCopies for the target ' +
            'object'));
    }

    if (!u.headers) {
        return (new Error('get-mpu did not return the target object headers'));
    }

    if (u.state === 'created') {
        // A created upload will have 'partsDirectory', but finalized uploads
        // will not.
        if (!u.partsDirectory) {
            return (new Error('get-mpu returned an upload in state "created" ' +
                'with no "partsDirectory" field'));
        }
    } else if (u.state === 'finalizing') {
        if (!u.type) {
            return (new Error('get-mpu returned an upload in state ' +
                '"finalizing" with no "type" field'));
        }
        if (!(u.type === 'abort' || u.type === 'commit')) {
            return (new Error(sprintf('get-mpu returned an upload in state ' +
                '"finalizing" with invalid "type": %s'), u.type));
        }

    } else {
        // Uploads in state "done" have a "result" field that specifies whether
        // it was committed or aborted, but no type.
        if (!u.result) {
            return (new Error('get-mpu returned an upload in state ' +
                '"done" with no "result" field'));
        }
        if (!(u.result === 'aborted' || u.result === 'committed')) {
            return (new Error(sprintf('get-mpu returned an upload in state ' +
                '"finalizing" with invalid "result": %s', u.result)));
        }
        if (u.result === 'committed') {
            if (!u.partsMD5Summary) {
                return (new Error('get-mpu returned an upload in state ' +
                    '"finalizing", result "committed", with no ' +
                    '"partsMD5Summary" field'));
            }
        }
    }

    return (null);
}

///--- Exports

module.exports = {
    MIN_UPLOAD_SIZE: MIN_UPLOAD_SIZE,
    MAX_TEST_UPLOAD_SIZE: MAX_TEST_UPLOAD_SIZE,
    MIN_NUM_COPIES: MIN_NUM_COPIES,
    MAX_NUM_COPIES: MAX_NUM_COPIES,
    MIN_PART_NUM: MIN_PART_NUM,
    MAX_PART_NUM: MAX_PART_NUM,
    TEXT: TEXT,
    TEXT_MD5: TEXT_MD5,
    ZERO_BYTE_MD5: ZERO_BYTE_MD5,

    cleanupMPUTester: cleanupMPUTester,
    initMPUTester: initMPUTester,
    ifErr: ifErr,
    between: between,
    randomPartNum: randomPartNum,
    randomUploadSize: randomUploadSize,
    randomNumCopies: randomNumCopies,
    computePartsMD5: computePartsMD5
};
