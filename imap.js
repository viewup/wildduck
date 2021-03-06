'use strict';

const log = require('npmlog');
const util = require('util');
const config = require('config');
const IMAPServerModule = require('./imap-core');
const IMAPServer = IMAPServerModule.IMAPServer;
const ImapNotifier = require('./lib/imap-notifier');
const imapHandler = IMAPServerModule.imapHandler;
const ObjectID = require('mongodb').ObjectID;
const Indexer = require('./imap-core/lib/indexer/indexer');
const imapTools = require('./imap-core/lib/imap-tools');
const fs = require('fs');
const setupIndexes = require('./indexes.json');
const MessageHandler = require('./lib/message-handler');
const UserHandler = require('./lib/user-handler');
const db = require('./lib/db');
const RedFour = require('redfour');
const packageData = require('./package.json');

// home many modifications to cache before writing
const BULK_BATCH_SIZE = 150;

// how often to clear expired messages
const GC_INTERVAL = 1 * 60 * 1000;

// Setup server
const serverOptions = {
    secure: config.imap.secure,
    ignoreSTARTTLS: config.imap.ignoreSTARTTLS,

    id: {
        name: 'Wild Duck IMAP Server',
        version: packageData.version,
        vendor: 'Kreata'
    },

    logger: {
        info(...args) {
            args.shift();
            log.info('IMAP', ...args);
        },
        debug(...args) {
            args.shift();
            log.silly('IMAP', ...args);
        },
        error(...args) {
            args.shift();
            log.error('IMAP', ...args);
        }
    },

    maxMessage: config.imap.maxMB * 1024 * 1024,
    maxStorage: config.maxStorage * 1024 * 1024
};

if (config.imap.key) {
    serverOptions.key = fs.readFileSync(config.imap.key);
}

if (config.imap.cert) {
    serverOptions.cert = fs.readFileSync(config.imap.cert);
}

const server = new IMAPServer(serverOptions);

let messageHandler;
let userHandler;
let gcTimeout;
let gcLock;

server.onAuth = function (login, session, callback) {
    let username = (login.username || '').toString().trim();

    userHandler.authenticate(username, login.password, {
        protocol: 'IMAP',
        ip: session.remoteAddress
    }, (err, result) => {
        if (err) {
            return callback(err);
        }
        if (!result) {
            return callback();
        }

        if (result.scope === 'master' && result.enabled2fa) {
            // master password not allowed if 2fa is enabled!
            return callback();
        }

        callback(null, {
            user: {
                id: result.user,
                username: result.username
            }
        });
    });
};

// LIST "" "*"
// Returns all folders, query is informational
// folders is either an Array or a Map
server.onList = function (query, session, callback) {
    this.logger.debug({
        tnx: 'list',
        cid: session.id
    }, '[%s] LIST for "%s"', session.id, query);
    db.database.collection('mailboxes').find({
        user: session.user.id
    }).toArray(callback);
};

// LSUB "" "*"
// Returns all subscribed folders, query is informational
// folders is either an Array or a Map
server.onLsub = function (query, session, callback) {
    this.logger.debug({
        tnx: 'lsub',
        cid: session.id
    }, '[%s] LSUB for "%s"', session.id, query);
    db.database.collection('mailboxes').find({
        user: session.user.id,
        subscribed: true
    }).toArray(callback);
};

// SUBSCRIBE "path/to/mailbox"
server.onSubscribe = function (path, session, callback) {
    this.logger.debug({
        tnx: 'subscribe',
        cid: session.id
    }, '[%s] SUBSCRIBE to "%s"', session.id, path);
    db.database.collection('mailboxes').findOneAndUpdate({
        user: session.user.id,
        path
    }, {
        $set: {
            subscribed: true
        }
    }, {}, (err, item) => {
        if (err) {
            return callback(err);
        }

        if (!item || !item.value) {
            // was not able to acquire a lock
            return callback(null, 'NONEXISTENT');
        }

        callback(null, true);
    });
};

// UNSUBSCRIBE "path/to/mailbox"
server.onUnsubscribe = function (path, session, callback) {
    this.logger.debug({
        tnx: 'unsubscribe',
        cid: session.id
    }, '[%s] UNSUBSCRIBE from "%s"', session.id, path);
    db.database.collection('mailboxes').findOneAndUpdate({
        user: session.user.id,
        path
    }, {
        $set: {
            subscribed: false
        }
    }, {}, (err, item) => {
        if (err) {
            return callback(err);
        }

        if (!item || !item.value) {
            // was not able to acquire a lock
            return callback(null, 'NONEXISTENT');
        }

        callback(null, true);
    });
};

// CREATE "path/to/mailbox"
server.onCreate = function (path, session, callback) {
    this.logger.debug({
        tnx: 'create',
        cid: session.id
    }, '[%s] CREATE "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (mailbox) {
            return callback(null, 'ALREADYEXISTS');
        }

        db.database.collection('users').findOne({
            _id: session.user.id
        }, {
            fields: {
                retention: true
            }
        }, (err, user) => {
            if (err) {
                return callback(err);
            }

            mailbox = {
                user: session.user.id,
                path,
                uidValidity: Math.floor(Date.now() / 1000),
                uidNext: 1,
                modifyIndex: 0,
                subscribed: true,
                flags: [],
                retention: user.retention
            };

            db.database.collection('mailboxes').insertOne(mailbox, err => {
                if (err) {
                    return callback(err);
                }
                return callback(null, true);
            });
        });
    });
};

// RENAME "path/to/mailbox" "new/path"
// NB! RENAME affects child and hierarchy mailboxes as well, this example does not do this
server.onRename = function (path, newname, session, callback) {
    this.logger.debug({
        tnx: 'rename',
        cid: session.id
    }, '[%s] RENAME "%s" to "%s"', session.id, path, newname);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path: newname
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (mailbox) {
            return callback(null, 'ALREADYEXISTS');
        }

        db.database.collection('mailboxes').findOneAndUpdate({
            user: session.user.id,
            path
        }, {
            $set: {
                path: newname
            }
        }, {}, (err, item) => {
            if (err) {
                return callback(err);
            }

            if (!item || !item.value) {
                // was not able to acquire a lock
                return callback(null, 'NONEXISTENT');
            }

            callback(null, true);
        });
    });
};

// DELETE "path/to/mailbox"
server.onDelete = function (path, session, callback) {
    this.logger.debug({
        tnx: 'delete',
        cid: session.id
    }, '[%s] DELETE "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }
        if (mailbox.specialUse) {
            return callback(null, 'CANNOT');
        }

        db.database.collection('mailboxes').deleteOne({
            _id: mailbox._id
        }, err => {
            if (err) {
                return callback(err);
            }

            // calculate mailbox size by aggregating the size's of all messages
            db.database.collection('messages').aggregate([{
                $match: {
                    mailbox: mailbox._id
                }
            }, {
                $group: {
                    _id: {
                        mailbox: '$mailbox'
                    },
                    storageUsed: {
                        $sum: '$size'
                    }
                }
            }], {
                cursor: {
                    batchSize: 1
                }
            }).toArray((err, res) => {
                if (err) {
                    return callback(err);
                }

                let storageUsed = res && res[0] && res[0].storageUsed || 0;

                db.database.collection('messages').deleteMany({
                    mailbox: mailbox._id
                }, err => {
                    if (err) {
                        return callback(err);
                    }

                    let done = () => {
                        db.database.collection('journal').deleteMany({
                            mailbox: mailbox._id
                        }, err => {
                            if (err) {
                                return callback(err);
                            }
                            callback(null, true);
                        });
                    };

                    if (!storageUsed) {
                        return done();
                    }

                    // decrement quota counters
                    db.database.collection('users').findOneAndUpdate({
                        _id: mailbox.user
                    }, {
                        $inc: {
                            storageUsed: -Number(storageUsed) || 0
                        }
                    }, done);
                });
            });
        });
    });
};

// SELECT/EXAMINE
server.onOpen = function (path, session, callback) {
    this.logger.debug({
        tnx: 'open',
        cid: session.id
    }, '[%s] Opening "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        db.database.collection('messages').find({
            mailbox: mailbox._id
        }).project({
            uid: true
        }).sort([
            ['uid', 1]
        ]).toArray((err, messages) => {
            if (err) {
                return callback(err);
            }
            mailbox.uidList = messages.map(message => message.uid);
            callback(null, mailbox);
        });
    });
};

// STATUS (X Y X)
server.onStatus = function (path, session, callback) {
    this.logger.debug({
        tnx: 'status',
        cid: session.id
    }, '[%s] Requested status for "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        db.database.collection('messages').find({
            mailbox: mailbox._id
        }).count((err, total) => {
            if (err) {
                return callback(err);
            }
            db.database.collection('messages').find({
                mailbox: mailbox._id,
                seen: false
            }).count((err, unseen) => {
                if (err) {
                    return callback(err);
                }

                return callback(null, {
                    messages: total,
                    uidNext: mailbox.uidNext,
                    uidValidity: mailbox.uidValidity,
                    unseen
                });
            });
        });

    });
};

// APPEND mailbox (flags) date message
server.onAppend = function (path, flags, date, raw, session, callback) {
    this.logger.debug({
        tnx: 'append',
        cid: session.id
    }, '[%s] Appending message to "%s"', session.id, path);

    db.database.collection('users').findOne({
        _id: session.user.id
    }, (err, user) => {
        if (err) {
            return callback(err);
        }
        if (!user) {
            return callback(new Error('User not found'));
        }

        if (user.quota && user.storageUsed > user.quota) {
            return callback(false, 'OVERQUOTA');
        }

        messageHandler.add({
            user: session.user.id,
            path,
            meta: {
                source: 'IMAP',
                to: session.user.username,
                time: Date.now()
            },
            session,
            date,
            flags,
            raw
        }, (err, status, data) => {
            if (err) {
                if (err.imapResponse) {
                    return callback(null, err.imapResponse);
                }
                return callback(err);
            }
            callback(null, status, data);
        });
    });
};

server.updateMailboxFlags = function (mailbox, update, callback) {
    if (update.action === 'remove') {
        // we didn't add any new flags, so there's nothing to update
        return callback();
    }

    let mailboxFlags = imapTools.systemFlags.concat(mailbox.flags || []).map(flag => flag.trim().toLowerCase());
    let newFlags = [];

    // find flags that are not listed with mailbox
    update.value.forEach(flag => {
        // limit mailbox flags by 100
        if (mailboxFlags.length + newFlags.length >= 100) {
            return;
        }
        // if mailbox does not have such flag, then add it
        if (!mailboxFlags.includes(flag.toLowerCase().trim())) {
            newFlags.push(flag);
        }
    });

    // nothing new found
    if (!newFlags.length) {
        return callback();
    }

    // found some new flags not yet set for mailbox
    // FIXME: Should we send unsolicited FLAGS and PERMANENTFLAGS notifications? Probably not
    return db.database.collection('mailboxes').findOneAndUpdate({
        _id: mailbox._id
    }, {
        $addToSet: {
            flags: {
                $each: newFlags
            }
        }
    }, {}, callback);
};

// STORE / UID STORE, updates flags for selected UIDs
server.onStore = function (path, update, session, callback) {
    this.logger.debug({
        tnx: 'store',
        cid: session.id
    }, '[%s] Updating messages in "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }

        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        let query = {
            mailbox: mailbox._id
        };

        if (update.unchangedSince) {
            query = {
                mailbox: mailbox._id,
                modseq: {
                    $lte: update.unchangedSince
                }
            };
        }

        let queryAll = false;
        if (update.messages.length !== session.selected.uidList.length) {
            // do not use uid selector for 1:*
            query.uid = {
                $in: update.messages
            };
        } else {
            // 1:*
            queryAll = true;
        }

        let cursor = db.database.collection('messages').
        find(query).
        project({
            _id: true,
            uid: true,
            flags: true
        }).sort([
            ['uid', 1]
        ]);

        let updateEntries = [];
        let notifyEntries = [];

        let done = (...args) => {
            if (updateEntries.length) {
                return db.database.collection('messages').bulkWrite(updateEntries, {
                    ordered: false,
                    w: 1
                }, () => {
                    updateEntries = [];
                    this.notifier.addEntries(session.user.id, path, notifyEntries, () => {
                        notifyEntries = [];
                        this.notifier.fire(session.user.id, path);
                        if (args[0]) { // first argument is an error
                            return callback(...args);
                        } else {
                            server.updateMailboxFlags(mailbox, update, () => callback(...args));
                        }
                    });
                });
            }
            this.notifier.fire(session.user.id, path);
            if (args[0]) { // first argument is an error
                return callback(...args);
            } else {
                server.updateMailboxFlags(mailbox, update, () => callback(...args));
            }
        };

        // We have to process all messages one by one instead of just calling an update
        // for all messages as we need to know which messages were exactly modified,
        // otherwise we can't send flag update notifications and modify modseq values
        let processNext = () => {
            cursor.next((err, message) => {
                if (err) {
                    return done(err);
                }
                if (!message) {
                    return cursor.close(() => done(null, true));
                }
                if (queryAll && !session.selected.uidList.includes(message.uid)) {
                    // skip processing messages that we do not know about yet
                    return processNext();
                }

                let flagsupdate = false; // query object for updates

                let updated = false;
                let existingFlags = message.flags.map(flag => flag.toLowerCase().trim());
                switch (update.action) {
                    case 'set':
                        // check if update set matches current or is different
                        if (
                            // if length does not match
                            existingFlags.length !== update.value.length ||
                            // or a new flag was found
                            update.value.filter(flag => !existingFlags.includes(flag.toLowerCase().trim())).length
                        ) {
                            updated = true;
                        }

                        message.flags = [].concat(update.value);

                        // set flags
                        if (updated) {
                            flagsupdate = {
                                $set: {
                                    flags: message.flags,
                                    seen: message.flags.includes('\\Seen'),
                                    flagged: message.flags.includes('\\Flagged'),
                                    deleted: message.flags.includes('\\Deleted'),
                                    draft: message.flags.includes('\\Draft')
                                }
                            };
                        }
                        break;

                    case 'add':
                        {
                            let newFlags = [];
                            message.flags = message.flags.concat(update.value.filter(flag => {
                                if (!existingFlags.includes(flag.toLowerCase().trim())) {
                                    updated = true;
                                    newFlags.push(flag);
                                    return true;
                                }
                                return false;
                            }));

                            // add flags
                            if (updated) {
                                flagsupdate = {
                                    $addToSet: {
                                        flags: {
                                            $each: newFlags
                                        }
                                    }
                                };

                                if (newFlags.includes('\\Seen') || newFlags.includes('\\Flagged') || newFlags.includes('\\Deleted') || newFlags.includes('\\Draft')) {
                                    flagsupdate.$set = {};
                                    if (newFlags.includes('\\Seen')) {
                                        flagsupdate.$set = {
                                            seen: true
                                        };
                                    }
                                    if (newFlags.includes('\\Flagged')) {
                                        flagsupdate.$set = {
                                            flagged: true
                                        };
                                    }
                                    if (newFlags.includes('\\Deleted')) {
                                        flagsupdate.$set = {
                                            deleted: true
                                        };
                                    }
                                    if (newFlags.includes('\\Draft')) {
                                        flagsupdate.$set = {
                                            draft: true
                                        };
                                    }
                                }
                            }
                            break;
                        }

                    case 'remove':
                        {
                            // We need to use the case of existing flags when removing
                            let oldFlags = [];
                            let flagsUpdates = update.value.map(flag => flag.toLowerCase().trim());
                            message.flags = message.flags.filter(flag => {
                                if (!flagsUpdates.includes(flag.toLowerCase().trim())) {
                                    return true;
                                }
                                oldFlags.push(flag);
                                updated = true;
                                return false;
                            });

                            // remove flags
                            if (updated) {
                                flagsupdate = {
                                    $pull: {
                                        flags: {
                                            $in: oldFlags
                                        }
                                    }
                                };
                                if (oldFlags.includes('\\Seen') || oldFlags.includes('\\Flagged') || oldFlags.includes('\\Deleted') || oldFlags.includes('\\Draft')) {
                                    flagsupdate.$set = {};
                                    if (oldFlags.includes('\\Seen')) {
                                        flagsupdate.$set = {
                                            seen: false
                                        };
                                    }
                                    if (oldFlags.includes('\\Flagged')) {
                                        flagsupdate.$set = {
                                            flagged: false
                                        };
                                    }
                                    if (oldFlags.includes('\\Deleted')) {
                                        flagsupdate.$set = {
                                            deleted: false
                                        };
                                    }
                                    if (oldFlags.includes('\\Draft')) {
                                        flagsupdate.$set = {
                                            draft: false
                                        };
                                    }
                                }
                            }
                            break;
                        }
                }

                if (!update.silent) {
                    // print updated state of the message
                    session.writeStream.write(session.formatResponse('FETCH', message.uid, {
                        uid: update.isUid ? message.uid : false,
                        flags: message.flags
                    }));
                }

                if (updated) {
                    updateEntries.push({
                        updateOne: {
                            filter: {
                                _id: message._id
                            },
                            update: flagsupdate
                        }
                    });

                    notifyEntries.push({
                        command: 'FETCH',
                        ignore: session.id,
                        uid: message.uid,
                        flags: message.flags,
                        message: message._id
                    });

                    if (updateEntries.length >= BULK_BATCH_SIZE) {
                        return db.database.collection('messages').bulkWrite(updateEntries, {
                            ordered: false,
                            w: 1
                        }, err => {
                            updateEntries = [];
                            if (err) {
                                return cursor.close(() => done(err));
                            }

                            this.notifier.addEntries(session.user.id, path, notifyEntries, () => {
                                notifyEntries = [];
                                this.notifier.fire(session.user.id, path);
                                processNext();
                            });
                        });
                    } else {
                        processNext();
                    }
                } else {
                    processNext();
                }
            });
        };

        processNext();
    });
};

// EXPUNGE deletes all messages in selected mailbox marked with \Delete
server.onExpunge = function (path, update, session, callback) {
    this.logger.debug({
        tnx: 'expunge',
        cid: session.id
    }, '[%s] Deleting messages from "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        let cursor = db.database.collection('messages').find({
            mailbox: mailbox._id,
            deleted: true
        }).project({
            _id: true,
            uid: true,
            size: true,
            map: true,
            magic: true
        }).sort([
            ['uid', 1]
        ]);

        let deletedMessages = 0;
        let deletedStorage = 0;

        let updateQuota = next => {
            if (!deletedMessages) {
                return next();
            }

            db.database.collection('users').findOneAndUpdate({
                _id: mailbox.user
            }, {
                $inc: {
                    storageUsed: -deletedStorage
                }
            }, next);
        };

        let processNext = () => {
            cursor.next((err, message) => {
                if (err) {
                    return updateQuota(() => callback(err));
                }
                if (!message) {
                    return cursor.close(() => {
                        updateQuota(() => {
                            this.notifier.fire(session.user.id, path);
                            return callback(null, true);
                        });
                    });
                }

                if (!update.silent) {
                    session.writeStream.write(session.formatResponse('EXPUNGE', message.uid));
                }

                db.database.collection('messages').deleteOne({
                    _id: message._id
                }, err => {
                    if (err) {
                        return updateQuota(() => cursor.close(() => callback(err)));
                    }

                    deletedMessages++;
                    deletedStorage += Number(message.size) || 0;

                    let attachments = Object.keys(message.map || {}).map(key => message.map[key]);

                    if (!attachments.length) {
                        // not stored attachments
                        return this.notifier.addEntries(session.user.id, path, {
                            command: 'EXPUNGE',
                            ignore: session.id,
                            uid: message.uid,
                            message: message._id
                        }, processNext);
                    }

                    // remove references to attachments (if any exist)
                    db.database.collection('attachments.files').updateMany({
                        _id: {
                            $in: attachments
                        }
                    }, {
                        $inc: {
                            'metadata.c': -1,
                            'metadata.m': -message.magic
                        }
                    }, {
                        multi: true,
                        w: 1
                    }, err => {
                        if (err) {
                            // ignore as we don't really care if we have orphans or not
                        }
                        this.notifier.addEntries(session.user.id, path, {
                            command: 'EXPUNGE',
                            ignore: session.id,
                            uid: message.uid,
                            message: message._id
                        }, processNext);
                    });
                });
            });
        };

        processNext();
    });
};

// COPY / UID COPY sequence mailbox
server.onCopy = function (path, update, session, callback) {
    this.logger.debug({
        tnx: 'copy',
        cid: session.id
    }, '[%s] Copying messages from "%s" to "%s"', session.id, path, update.destination);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        db.database.collection('mailboxes').findOne({
            user: session.user.id,
            path: update.destination
        }, (err, target) => {
            if (err) {
                return callback(err);
            }
            if (!target) {
                return callback(null, 'TRYCREATE');
            }

            let cursor = db.database.collection('messages').find({
                mailbox: mailbox._id,
                uid: {
                    $in: update.messages
                }
            }).sort([
                ['uid', 1]
            ]); // no projection as we need to copy the entire message

            let copiedMessages = 0;
            let copiedStorage = 0;

            let updateQuota = next => {
                if (!copiedMessages) {
                    return next();
                }
                db.database.collection('users').findOneAndUpdate({
                    _id: mailbox.user
                }, {
                    $inc: {
                        storageUsed: copiedStorage
                    }
                }, next);
            };

            let sourceUid = [];
            let destinationUid = [];
            let processNext = () => {
                cursor.next((err, message) => {
                    if (err) {
                        return updateQuota(() => callback(err));
                    }
                    if (!message) {
                        return cursor.close(() => {
                            updateQuota(() => {
                                this.notifier.fire(session.user.id, target.path);
                                return callback(null, true, {
                                    uidValidity: target.uidValidity,
                                    sourceUid,
                                    destinationUid
                                });
                            });
                        });
                    }

                    // Copying is not done in bulk to minimize risk of going out of sync with incremental UIDs
                    sourceUid.unshift(message.uid);
                    db.database.collection('mailboxes').findOneAndUpdate({
                        _id: target._id
                    }, {
                        $inc: {
                            uidNext: 1
                        }
                    }, {
                        uidNext: true
                    }, (err, item) => {
                        if (err) {
                            return cursor.close(() => {
                                updateQuota(() => callback(err));
                            });
                        }

                        if (!item || !item.value) {
                            // was not able to acquire a lock
                            return cursor.close(() => {
                                updateQuota(() => callback(null, 'TRYCREATE'));
                            });
                        }

                        let uidNext = item.value.uidNext;
                        destinationUid.unshift(uidNext);

                        message._id = new ObjectID();
                        message.mailbox = target._id;
                        message.uid = uidNext;

                        // retention settings
                        message.exp = !!target.retention;
                        message.rdate = Date.now() + (target.retention || 0);

                        if (!message.meta) {
                            message.meta = {};
                        }
                        message.meta.source = 'IMAPCOPY';

                        db.database.collection('messages').insertOne(message, err => {
                            if (err) {
                                return cursor.close(() => {
                                    updateQuota(() => callback(err));
                                });
                            }

                            copiedMessages++;
                            copiedStorage += Number(message.size) || 0;

                            let attachments = Object.keys(message.map || {}).map(key => message.map[key]);
                            if (!attachments.length) {
                                return this.notifier.addEntries(session.user.id, target.path, {
                                    command: 'EXISTS',
                                    uid: message.uid,
                                    message: message._id
                                }, processNext);
                            }

                            // update attachments
                            db.database.collection('attachments.files').updateMany({
                                _id: {
                                    $in: attachments
                                }
                            }, {
                                $inc: {
                                    'metadata.c': 1,
                                    'metadata.m': message.magic
                                }
                            }, {
                                multi: true,
                                w: 1
                            }, err => {
                                if (err) {
                                    // should we care about this error?
                                }
                                this.notifier.addEntries(session.user.id, target.path, {
                                    command: 'EXISTS',
                                    uid: message.uid,
                                    message: message._id
                                }, processNext);
                            });
                        });
                    });
                });
            };
            processNext();
        });
    });
};

// MOVE / UID MOVE sequence mailbox
server.onMove = function (path, update, session, callback) {
    this.logger.debug({
        tnx: 'move',
        cid: session.id
    }, '[%s] Moving messages from "%s" to "%s"', session.id, path, update.destination);

    messageHandler.move({
        user: session.user.id,
        // folder to move messages from
        source: {
            user: session.user.id,
            path
        },
        // folder to move messages to
        destination: {
            user: session.user.id,
            path: update.destination
        },
        session,
        // list of UIDs to move
        messages: update.messages
    }, (...args) => {
        if (args[0]) {
            if (args[0].imapResponse) {
                return callback(null, args[0].imapResponse);
            }
            return callback(args[0]);
        }
        callback(...args);
    });
};

// sends results to socket
server.onFetch = function (path, options, session, callback) {
    this.logger.debug({
        tnx: 'fetch',
        cid: session.id
    }, '[%s] Requested FETCH for "%s"', session.id, path);
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        let projection = {
            uid: true,
            modseq: true,
            idate: true,
            flags: true,
            envelope: true,
            bodystructure: true,
            size: true
        };

        if (!options.metadataOnly) {
            projection.mimeTree = true;
        }

        let query = {
            mailbox: mailbox._id
        };

        if (options.changedSince) {
            query = {
                mailbox: mailbox._id,
                modseq: {
                    $gt: options.changedSince
                }
            };
        }

        let queryAll = false;
        if (options.messages.length !== session.selected.uidList.length) {
            // do not use uid selector for 1:*
            query.uid = {
                $in: options.messages
            };
        } else {
            // 1:*
            queryAll = true;
        }

        let isUpdated = false;
        let updateEntries = [];
        let notifyEntries = [];

        let done = (...args) => {
            if (updateEntries.length) {
                return db.database.collection('messages').bulkWrite(updateEntries, {
                    ordered: false,
                    w: 1
                }, () => {
                    updateEntries = [];
                    this.notifier.addEntries(session.user.id, path, notifyEntries, () => {
                        notifyEntries = [];
                        this.notifier.fire(session.user.id, path);
                        return callback(...args);
                    });
                });
            }
            if (isUpdated) {
                this.notifier.fire(session.user.id, path);
            }
            return callback(...args);
        };

        let cursor = db.database.collection('messages').
        find(query).
        project(projection).
        sort([
            ['uid', 1]
        ]);

        let rowCount = 0;
        let processNext = () => {
            cursor.next((err, message) => {
                if (err) {
                    return done(err);
                }
                if (!message) {
                    return cursor.close(() => {
                        done(null, true);
                    });
                }

                if (queryAll && !session.selected.uidList.includes(message.uid)) {
                    // skip processing messages that we do not know about yet
                    return processNext();
                }

                let markAsSeen = options.markAsSeen && !message.flags.includes('\\Seen');
                if (markAsSeen) {
                    message.flags.unshift('\\Seen');
                }

                let stream = imapHandler.compileStream(session.formatResponse('FETCH', message.uid, {
                    query: options.query,
                    values: session.getQueryResponse(options.query, message, {
                        logger: this.logger,
                        fetchOptions: {},
                        database: db.database,
                        acceptUTF8Enabled: session.isUTF8Enabled()
                    })
                }));

                stream.description = util.format('* FETCH #%s uid=%s size=%sB ', ++rowCount, message.uid, message.size);

                stream.on('error', err => {
                    session.socket.write('INTERNAL ERROR\n');
                    session.socket.destroy(); // ended up in erroneus state, kill the connection to abort
                    return cursor.close(() => done(err));
                });

                // send formatted response to socket
                session.writeStream.write(stream, () => {
                    if (!markAsSeen) {
                        return processNext();
                    }

                    this.logger.debug({
                        tnx: 'flags',
                        cid: session.id
                    }, '[%s] UPDATE FLAGS for "%s"', session.id, message.uid);

                    isUpdated = true;

                    updateEntries.push({
                        updateOne: {
                            filter: {
                                _id: message._id
                            },
                            update: {
                                $addToSet: {
                                    flags: '\\Seen'
                                },
                                $set: {
                                    seen: true
                                }
                            }
                        }
                    });

                    notifyEntries.push({
                        command: 'FETCH',
                        ignore: session.id,
                        uid: message.uid,
                        flags: message.flags,
                        message: message._id
                    });

                    if (updateEntries.length >= BULK_BATCH_SIZE) {
                        return db.database.collection('messages').bulkWrite(updateEntries, {
                            ordered: false,
                            w: 1
                        }, err => {
                            updateEntries = [];
                            if (err) {
                                return cursor.close(() => done(err));
                            }

                            this.notifier.addEntries(session.user.id, path, notifyEntries, () => {
                                notifyEntries = [];
                                this.notifier.fire(session.user.id, path);
                                processNext();
                            });
                        });
                    } else {
                        processNext();
                    }
                });
            });
        };

        processNext();
    });
};

/**
 * Returns an array of matching UID values
 *
 * IMAP search can be quite complex, so we optimize here for most common queries to be handled
 * by MongoDB and then do the final filtering on the client side. This allows
 */
server.onSearch = function (path, options, session, callback) {
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        // prepare query

        let query = {
            mailbox: mailbox._id
        };

        let walkQuery = (parent, ne, node) => {
            node.forEach(term => {
                switch (term.key) {
                    case 'all':
                        if (ne) {
                            parent.push({
                                // should not match anything
                                _id: -1
                            });
                        }
                        break;

                    case 'not':
                        walkQuery(parent, !ne, [].concat(term.value || []));
                        break;

                    case 'or':
                        {
                            let $or = [];

                            [].concat(term.value || []).forEach(entry => {
                                walkQuery($or, false, [].concat(entry || []));
                            });

                            if ($or.length) {
                                parent.push({
                                    $or
                                });
                            }

                            break;
                        }

                    case 'text': // search over entire email
                    case 'body': // search over email body
                        if (term.value && !ne) {
                            // fulltext can only be in the root of the query, not in $not, $or expressions
                            // https://docs.mongodb.com/v3.4/tutorial/text-search-in-aggregation/#restrictions
                            query.$text = {
                                $search: term.value
                            };
                        } else {
                            // can not search by text
                            parent.push({
                                // should not match anything
                                _id: -1
                            });
                        }
                        break;

                    case 'modseq':
                        parent.push({
                            modseq: {
                                [!ne ? '$gte' : '$lt']: term.value
                            }
                        });
                        break;

                    case 'uid':
                        if (Array.isArray(term.value)) {
                            if (!term.value.length) {
                                // trying to find a message that does not exist
                                return callback(null, {
                                    uidList: [],
                                    highestModseq: 0
                                });
                            }
                            if (term.value.length !== session.selected.uidList.length) {
                                // not 1:*
                                parent.push({
                                    uid: {
                                        [!ne ? '$in' : '$nin']: term.value
                                    }
                                });
                            } else if (ne) {
                                parent.push({
                                    // should not match anything
                                    _id: -1
                                });
                            }
                        } else {
                            parent.push({
                                uid: {
                                    [!ne ? '$eq' : '$ne']: term.value
                                }
                            });
                        }
                        break;

                    case 'flag':
                        {
                            switch (term.value) {
                                case '\\Seen':
                                case '\\Deleted':
                                case '\\Flagged':
                                case '\\Draft':
                                    if (term.exists) {
                                        parent.push({
                                            [term.value.toLowerCase().substr(1)]: !ne
                                        });
                                    } else {
                                        parent.push({
                                            [term.value.toLowerCase().substr(1)]: ne
                                        });
                                    }
                                    break;
                                default:
                                    if (term.exists) {
                                        parent.push({
                                            flags: {
                                                [!ne ? '$eq' : '$ne']: term.value
                                            }
                                        });
                                    } else {
                                        parent.push({
                                            flags: {
                                                [!ne ? '$ne' : '$eq']: term.value
                                            }
                                        });
                                    }
                            }
                        }
                        break;

                    case 'header':
                        {
                            // FIXME: this does not match unicode symbols for whatever reason
                            let regex = Buffer.from(term.value, 'binary').toString().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                            let entry = term.value ? {
                                headers: {
                                    $elemMatch: {
                                        key: term.header,
                                        value: !ne ? {
                                            $regex: regex,
                                            $options: 'i'
                                        } : {
                                            $not: {
                                                $regex: regex,
                                                $options: 'i'
                                            }
                                        }
                                    }
                                }
                            } : {
                                'headers.key': !ne ? term.header : {
                                    $ne: term.header
                                }
                            };
                            parent.push(entry);
                        }
                        break;

                    case 'internaldate':
                        {
                            let op = false;
                            let value = new Date(term.value + ' GMT');
                            switch (term.operator) {
                                case '<':
                                    op = '$lt';
                                    break;
                                case '<=':
                                    op = '$lte';
                                    break;
                                case '>':
                                    op = '$gt';
                                    break;
                                case '>=':
                                    op = '$gte';
                                    break;
                            }
                            let entry = !op ? [{
                                $gte: value
                            }, {
                                $lt: new Date(value.getTime() + 24 * 3600 * 1000)
                            }] : {
                                [op]: value
                            };

                            entry = {
                                idate: !ne ? entry : {
                                    $not: entry
                                }
                            };

                            parent.push(entry);
                        }
                        break;

                    case 'headerdate':
                        {
                            let op = false;
                            let value = new Date(term.value + ' GMT');
                            switch (term.operator) {
                                case '<':
                                    op = '$lt';
                                    break;
                                case '<=':
                                    op = '$lte';
                                    break;
                                case '>':
                                    op = '$gt';
                                    break;
                                case '>=':
                                    op = '$gte';
                                    break;
                            }
                            let entry = !op ? [{
                                $gte: value
                            }, {
                                $lt: new Date(value.getTime() + 24 * 3600 * 1000)
                            }] : {
                                [op]: value
                            };

                            entry = {
                                hdate: !ne ? entry : {
                                    $not: entry
                                }
                            };

                            parent.push(entry);
                        }
                        break;

                    case 'size':
                        {
                            let op = '$eq';
                            let value = Number(term.value) || 0;
                            switch (term.operator) {
                                case '<':
                                    op = '$lt';
                                    break;
                                case '<=':
                                    op = '$lte';
                                    break;
                                case '>':
                                    op = '$gt';
                                    break;
                                case '>=':
                                    op = '$gte';
                                    break;
                            }

                            let entry = {
                                [op]: value
                            };

                            entry = {
                                size: !ne ? entry : {
                                    $not: entry
                                }
                            };

                            parent.push(entry);
                        }
                        break;
                }
            });
        };

        let $and = [];
        walkQuery($and, false, options.query);
        if ($and.length) {
            query.$and = $and;
        }

        this.logger.info({
            tnx: 'search',
            cid: session.id
        }, '[%s] SEARCH %s', session.id, JSON.stringify(query));

        let cursor = db.database.collection('messages').
        find(query).
        project({
            uid: true,
            modseq: true
        });

        let highestModseq = 0;
        let uidList = [];

        let processNext = () => {
            cursor.next((err, message) => {
                if (err) {
                    this.logger.error({
                        tnx: 'search',
                        cid: session.id
                    }, '[%s] SEARCHFAIL %s error="%s"', session.id, JSON.stringify(query), err.message);
                    return callback(new Error('Can not make requested search query'));
                }
                if (!message) {
                    return cursor.close(() => callback(null, {
                        uidList,
                        highestModseq
                    }));
                }

                if (highestModseq < message.modseq) {
                    highestModseq = message.modseq;
                }

                uidList.push(message.uid);
                processNext();
            });
        };

        processNext();
    });
};

server.onGetQuotaRoot = function (path, session, callback) {
    this.logger.debug({
        tnx: 'quota',
        cid: session.id
    }, '[%s] Requested quota root info for "%s"', session.id, path);

    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        db.database.collection('users').findOne({
            _id: session.user.id
        }, (err, user) => {
            if (err) {
                return callback(err);
            }
            if (!user) {
                return callback(new Error('User data not found'));
            }

            return callback(null, {
                root: '',
                quota: user.quota || server.options.maxStorage || 0,
                storageUsed: Math.max(user.storageUsed || 0, 0)
            });
        });
    });
};

server.onGetQuota = function (quotaRoot, session, callback) {
    this.logger.debug({
        tnx: 'quota',
        cid: session.id
    }, '[%s] Requested quota info for "%s"', session.id, quotaRoot);

    if (quotaRoot !== '') {
        return callback(null, 'NONEXISTENT');
    }

    db.database.collection('users').findOne({
        _id: session.user.id
    }, (err, user) => {
        if (err) {
            return callback(err);
        }
        if (!user) {
            return callback(new Error('User data not found'));
        }

        return callback(null, {
            root: '',
            quota: user.quota || server.options.maxStorage || 0,
            storageUsed: Math.max(user.storageUsed || 0, 0)
        });
    });
};

function deleteOrphanedAttachments(callback) {
    let cursor = db.database.collection('attachments.files').find({
        'metadata.c': 0,
        'metadata.m': 0
    });

    let deleted = 0;
    let processNext = () => {
        cursor.next((err, attachment) => {
            if (err) {
                return callback(err);
            }
            if (!attachment) {
                return cursor.close(() => {
                    // delete all attachments that do not have any active links to message objects
                    callback(null, deleted);
                });
            }

            if (!attachment || (attachment.metadata && attachment.metadata.c)) {
                // skip
                return processNext();
            }

            // delete file entry first
            db.database.collection('attachments.files').deleteOne({
                _id: attachment._id,
                // make sure that we do not delete a message that is already re-used
                'metadata.c': 0,
                'metadata.m': 0
            }, (err, result) => {
                if (err || !result.deletedCount) {
                    return processNext();
                }

                // delete data chunks
                db.database.collection('attachments.chunks').deleteMany({
                    files_id: attachment._id
                }, err => {
                    if (err) {
                        // ignore as we don't really care if we have orphans or not
                    }

                    deleted++;
                    processNext();
                });
            });
        });
    };

    processNext();
}

function clearExpiredMessages() {
    clearTimeout(gcTimeout);

    // First, acquire the lock. This prevents multiple connected clients for deleting the same messages
    gcLock.acquireLock('gc_expired', 10 * 60 * 1000 /* Lock expires after 10min if not released */ , (err, lock) => {
        if (err) {
            server.logger.error({
                tnx: 'gc',
                err
            }, 'Failed to acquire lock error=%s', err.message);
            gcTimeout = setTimeout(clearExpiredMessages, GC_INTERVAL);
            gcTimeout.unref();
            return;
        } else if (!lock.success) {
            gcTimeout = setTimeout(clearExpiredMessages, GC_INTERVAL);
            gcTimeout.unref();
            return;
        }

        let done = () => {
            gcLock.releaseLock(lock, err => {
                if (err) {
                    server.logger.error({
                        tnx: 'gc',
                        err
                    }, 'Failed to release lock error=%s', err.message);
                }
                gcTimeout = setTimeout(clearExpiredMessages, GC_INTERVAL);
                gcTimeout.unref();
            });
        };

        let cursor = db.database.collection('messages').find({
            exp: true,
            rdate: {
                $lte: Date.now()
            }
        }).project({
            _id: true,
            mailbox: true,
            uid: true,
            size: true,
            map: true,
            magic: true
        });

        let deleted = 0;
        let processNext = () => {
            cursor.next((err, message) => {
                if (err) {
                    return done(err);
                }
                if (!message) {
                    return cursor.close(() => {
                        // delete all attachments that do not have any active links to message objects
                        deleteOrphanedAttachments(() => {
                            server.logger.debug({
                                tnx: 'gc'
                            }, 'Deleted %s messages', deleted);
                            done(null, true);
                        });
                    });
                }

                server.logger.info({
                    tnx: 'gc',
                    err
                }, 'Deleting expired message id=%s', message._id);

                gcTimeout = setTimeout(clearExpiredMessages, GC_INTERVAL);

                messageHandler.del({
                    message,
                    skipAttachments: true
                }, err => {
                    if (err) {
                        return cursor.close(() => done(err));
                    }
                    deleted++;
                    processNext();
                });
            });
        };

        processNext();

    });
}

module.exports = done => {
    if (!config.imap.enabled) {
        return setImmediate(() => done(null, false));
    }

    let start = () => {

        messageHandler = new MessageHandler(db.database, db.redisConfig);
        userHandler = new UserHandler(db.database, db.redis);

        server.indexer = new Indexer({
            database: db.database
        });

        // setup notification system for updates
        server.notifier = new ImapNotifier({
            database: db.database
        });

        let started = false;

        server.on('error', err => {
            if (!started) {
                started = true;
                return done(err);
            }
            server.logger.error({
                err
            }, err);
        });

        // start listening
        server.listen(config.imap.port, config.imap.host, () => {
            if (started) {
                return server.close();
            }
            started = true;
            done(null, server);
        });
    };

    let indexpos = 0;
    let ensureIndexes = () => {
        if (indexpos >= setupIndexes.length) {
            server.logger.info({
                tnx: 'mongo'
            }, 'Setup indexes for %s collections', setupIndexes.length);

            gcLock = new RedFour({
                redis: db.redisConfig,
                namespace: 'wildduck'
            });

            gcTimeout = setTimeout(clearExpiredMessages, GC_INTERVAL);
            gcTimeout.unref();

            return start();
        }
        let index = setupIndexes[indexpos++];
        db.database.collection(index.collection).createIndexes(index.indexes, ensureIndexes);
    };
    ensureIndexes();
};
