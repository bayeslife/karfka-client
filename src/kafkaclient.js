// This client implementation connects directly to the Kafka nodes directly rather than connecting to Zookeeper
// The configuration only requires connectivity to Kafak and not zookeeper

var kafka = require('kafka-node')
var ConsumerGroup = kafka.ConsumerGroup
var HighLevelProducer = kafka.HighLevelProducer

var Consumer = kafka.Consumer

var debug = require('debug')('kafka-client')

const K2Client = function (kafkanodes) {
  var kfnodes = kafkanodes

  return {
    // close: function() {
    //   debug('Closing KafkaClient')
    //   client.close()
    // },
    producePayload: function (payload) {
      return new Promise(function (resolve, reject) {
        var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
        var producer = new HighLevelProducer(client)
            producer.send(payload, function (error, result) {
              debug('Sent payload to Kafka: ', payload)
              if (error) {
                console.error(error)
                reject(error)
              } else {
                resolve(true)
              }
              client.close()
            })
          })
    },
    produceTopicValue: function (value, topic, partition = 0) {
      var payload = [{
        topic: topic,
        partition: partition,
        messages: [JSON.stringify(value)],
        attributes: 0 /* Use GZip compression for the payload */
      }]
      return this.producePayload(payload)
    },
    produceTopicKeyValue: function (key, value, topic) {
      var payload = [{
        key: key,
        topic: topic,
        messages: [JSON.stringify(value)],
        attributes: 0 /* Use GZip compression for the payload */
      }]
      return this.producePayload(payload)
    },
    createTopic: function (topic) {
      var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      return new Promise(function (resolve, reject) {
        debug('Creating topics:', topic)
        client.createTopics(topic, true, function (error, results) {
        debug('CreatedTopic:' + results)
          if (!error) { resolve(results) } else { reject(error) }
          client.close()
        })
      })
    },
    getTopics: async function () {
      var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      var result = await new Promise(function (resolve, reject) {
       client.loadMetadataForTopics([], function (error, results) {
         if (error) {
           console.log(error)
           results()
         } else {
          resolve(results)
         }
         client.close()
       })
     })
     return result.map(function (node) {
       return node['metadata'] ? Object.keys(node.metadata) : []
     }).reduce((a, b) => a.concat(b), [])
    },
    getOffset: function (topic) {
      var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      debug('Get Offset:', topic)
      return new Promise(function (resolve, reject) {
        var offset = new kafka.Offset(client)
        offset.fetch([
          {
            topic,
            time: -1, // not sure why this gives us the latest offsets
            maxNum: 10
          }
        ], function (err, data) {
          if (err) {
            reject(err)
          } else if (data) {
            resolve(data)
          }
          client.close()
        })
      })
    },
    createSubscriber: async function (groupid, topic, messageHandler, fromOffset = 'latest') {
    var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      var topicOffsets = await this.getOffset(topic)
      var latestOffset = topicOffsets[topic]['0'][0]
      var targetOffset = latestOffset - 1
      var options = {
        autoCommit: true,
        fetchMaxWaitMs: 1000,
        fetchMaxBytes: 10000,
        fromOffset: true
      }
      var consumer = new Consumer(client, [{
        topic: topic,
        partition: 0,
        offset: targetOffset
      }], options)

      consumer.on('error', onError)
      consumer.on('message', onMessage)
      consumer.on('done', onDone)
      function onError (error) {
        console.error(error)
        console.error(error.stack)
      }
      function onDone (message) {
        debug('Done', message)
        // consumer.close(false,function(){});
      }
      function onMessage (message) {
        if (message.key && message.value.length > 0) {
          debug('%s read msg Topic="%s" Partition=%s Offset=%d highWaterOffset=%d Key=%s value=%s', this.client.clientId, message.topic, message.partition, message.offset, message.highWaterOffset, message.key, message.value)
          messageHandler(JSON.parse(message.value))
        }
      }
      return {
        close: function () {
          debug('Closing Subscriber')
          consumer.close(false, function () {})
        }
      }
    },
    createSubscriberGroup: function (group, topic, messageHandler, fromOffset = 'latest') {
      return new Promise((resolve, reject) => {
        var options = {
          autoCommit: true,
          id: 'consumer1',
          kafkaHost: kfnodes,
          // batch: undefined, // put client batch settings if you need them (see Client)
          groupId: group,
          sessionTimeout: 15000,
          protocol: ['roundrobin'],
          fromOffset: fromOffset
          // outOfRangeOffset: '
        }
        debug(`Creating ConsumerGroup for group ${group} and topic ${topic} from offset ${fromOffset}`)
        var consumerGroup = new ConsumerGroup(options, topic)
        consumerGroup.on('error', onError)
        consumerGroup.on('message', onMessage)
        // consumerGroup.on('done', onDone);
        function onError (error) {
          console.error(error)
          console.error(error.stack)
        }
        consumerGroup.connect()
        consumerGroup.once('connect', () => {
          debug('Connected')
          resolve({
            close: function () {
              debug('Closing Subscriber')
              consumerGroup.close(false, function () {
                debug('ConsumerGroup closed')
              })
            }
          })
        })
        // function onDone (message) {
        //   debug("Done",message)
        // }
        function onMessage (message) {
          if (message.key && message.value.length > 0) {
            debug('%s read msg Topic="%s" Partition=%s Offset=%d highWaterOffset=%d Key=%s value=%s', this.client.clientId, message.topic, message.partition, message.offset, message.highWaterOffset, message.key, message.value)
            messageHandler(JSON.parse(message.value))
          }
        }
      })
    },
    groupSelectAll: async function (groupid, topic) {
      var options = {
        id: 'consumer1',
        kafkaHost: kfnodes,
        // batch: undefined, // put client batch settings if you need them (see Client)
        groupId: groupid,
        sessionTimeout: 15000,
        protocol: ['roundrobin'],
        fromOffset: 'earliest',
        commitOffsetsOnFirstJoin: true

      }
      var content = []
      return new Promise(function (resolve, reject) {
        var consumerGroup = new ConsumerGroup(options, topic)
        consumerGroup.on('error', onError)
        consumerGroup.on('message', onMessage)
        consumerGroup.on('done', function (message) {
          consumerGroup.close(true, function () {
            resolve(content)
          })
        })
        function onError (error) {
          console.error(error)
          console.error(error.stack)
        }
        function onMessage (message) {
          if (message.key && message.value.length > 0) {
            content.push(JSON.parse(message.value))
          }
        }
      })
    },
    selectAll: function (topic) {
      var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      debug('Selecting all from topic:', topic)
      return new Promise(function (resolve, reject) {
        var content = []
        var options = {
          autoCommit: false,
          fetchMaxWaitMs: 1000,
          fetchMaxBytes: 10000,
          fromOffset: true
        }
        var consumer = new Consumer(client, [{
          topic: topic,
          partition: 0,
          offset: 0
        }], options)
        consumer.on('done', function (message) {
          consumer.close(true, function () {
            client.close()
            resolve(content)
          })
        })
        consumer.on('message', function (message) {
          if (message.key) {
            debug('consumed message offset:', message.offset, '=>', message.value)
            content.push(JSON.parse(message.value))
          }
        })
      })
    },
    batchConsume: async function (groupid, topic, batchsize) {
      var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      var topicOffsets = await this.getOffset(topic)
      var latestOffset = topicOffsets[topic]['0'][0]
      var targetOffset = latestOffset - batchsize > 0 ? latestOffset - batchsize : 0
      debug('Consuming from:', targetOffset, ' to offset:', latestOffset)
      return new Promise(function (resolve, reject) {
        var content = []
        var options = {
          autoCommit: false,
          fetchMaxWaitMs: 1000,
          fetchMaxBytes: 10000,
          fromOffset: true
        }
        var consumer = new Consumer(client, [{
          topic: topic,
          partition: 0,
          offset: targetOffset
        }], options)
        consumer.on('done', function (message) {
          consumer.close(true, function () {
            client.close()
            resolve(content)
          })
        })
        consumer.on('message', function (message) {
          if (message.key) {
            debug('consumed message offset:', message.offset, '=>', message.value)
            content.push(JSON.parse(message.value))
          }
        })
      })
    },
    getAdmin: function () {
      var client = new kafka.KafkaClient({ kafkaHost: kfnodes, autoConnect: true })
      const admin = new kafka.Admin(client)
      return {
        getGroups: async function () {
          return new Promise(function (resolve, reject) {
            admin.listGroups((err, res) => {
              if (err) {
                reject(err)
              } else {
                resolve(res)
              }
              client.close()
            })
          })
        }
      }
    }
  }
}

module.exports = K2Client
