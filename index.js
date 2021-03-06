/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 */

/**
 * Middleware service for handling emitted events on chronobank platform
 * @module Chronobank/eth-blockprocessor
 */

const mongoose = require('mongoose'),
  config = require('./config'),
  Web3 = require('web3'),
  net = require('net'),
  txLogModel = require('./models/txLogModel'),
  newTxLogModel = require('./models/newTxLogModel'),
  Promise = require('bluebird'),
  crypto = require('crypto'),
  _ = require('lodash');

mongoose.Promise = Promise;
mongoose.connect(config.mongo.data.uri);

const init = async () => {


  mongoose.connection.on('disconnected', () => {
    throw new Error('mongo disconnected!');
  });

  console.log('create indexes...');
  await newTxLogModel.init();

  let height = await txLogModel.find().sort({blockNumber: -1}).limit(1);
  height = _.get(height, '0.blockNumber', 0);

  let lastLogRecord = await newTxLogModel.find().sort({blockNumber: -1}).limit(1);
  let lastLogRecordNumber = _.get(lastLogRecord, '0.blockNumber', 0);

  if (lastLogRecordNumber)
    await newTxLogModel.remove({blockNumber: lastLogRecordNumber});


  const provider = new Web3.providers.IpcProvider(`${/^win/.test(process.platform) ? '\\\\.\\pipe\\' : ''}${config.web3.providers[0]}`, net);
  const web3 = new Web3(provider);

  const step = 100;


  for (let i = lastLogRecordNumber; i < height; i += step) {
    let startDate = Date.now();

    let logs = await new Promise((res, rej) =>
      web3.eth.filter({fromBlock: i, toBlock: i + step - 1})
        .get((err, result) => err ? rej(err) : res(result))
    ).timeout(120000);

    logs = logs.map(log => {
      let args = log.topics;
      let nonIndexedLogs = _.chain(log.data.replace('0x', '')).chunk(64).map(chunk => chunk.join('')).value();
      let dataIndexStart;

      if (args.length && nonIndexedLogs.length) {
        dataIndexStart = args.length;
        args.push(...nonIndexedLogs);
      }

      const txLog = new newTxLogModel({
        blockNumber: log.blockNumber,
        txIndex: log.transactionIndex,
        index: log.logIndex,
        removed: log.removed,
        signature: _.get(log, 'topics.0'),
        args: log.topics,
        dataIndexStart: dataIndexStart,
        address: log.address
      });

      txLog._id = crypto.createHash('md5').update(`${log.blockNumber}x${log.transactionIndex}x${log.logIndex}`).digest('hex');
      return txLog;
    });


    let bulkOps = logs.map(log => ({
      updateOne: {
        filter: {_id: log._id},
        update: {$set: log},
        upsert: true
      }
    }));

    if (bulkOps.length)
      await newTxLogModel.bulkWrite(bulkOps);
    console.log(`inserted logs in range ${i} to ${i + step - 1} took: ${(Date.now() - startDate) / 1000}s`);
  }


  console.log('migration completed!');

};

module.exports = init().catch(err => {
  console.log(err);
  process.exit(0);
});
