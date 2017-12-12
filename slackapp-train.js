'use-strict';

const request = require('request');
var log = console.log;

// connect to the Cloudant database
var Cloudant = require('cloudant');
var cloudant;
var cloudantDbName = '';

var discoveryEnvironmentId = '';
var discoveryCollectionId = '';
var discoveryUsername = '';
var discoveryPassword = '';
var discoveryApiVersionDate = '2017-10-16';

var slackbotAccessToken = '';

var apologyResponse = 'Whoops! Thanks for training me so that I can respond better next time. In the meantime, check the docs:\n' +
':ibm: https://console.bluemix.net/docs/containers/container_index.html' + '\n' + 
':kubernetes: https://kubernetes.io/docs/home/' + '\n' + 
':istio: https://istio.io/docs/';

var setupGlobalVariables = (args) => {
    discoveryEnvironmentId = args.discoveryEnvironmentId;
    discoveryCollectionId = args.discoveryCollectionId;
    discoveryUsername = args.discoveryUsername;
    discoveryPassword = args.discoveryPassword;
    slackbotAccessToken = args.slackbotAccessToken;    
    cloudant = Cloudant({url: args.cloudantUrl});
    cloudantDbName = args.cloudantDb;
};

var findQueryId1 = (errorMessage) => {
    var message = /\b\w{39}\b/.exec(errorMessage);
    if (message != null) {
        return message[0];
    }
    return '';
};

var findQueryId = (errorMessage) => {
    let pieces = errorMessage.split(' ');
    //log(pieces);
    for (let i = 1; i < pieces.length; i++) {
        if (pieces[i-1] == 'id' && pieces[i].indexOf('-') < 0 && pieces[i].length > 30) {
            return pieces[i];
        } 
    }
    return '';
};

var getDocumentIdRelevance = (queryTrainingDataList) => {
    var data = [];
    for (var i = 0; i < queryTrainingDataList.length; i++) {
        data.push({
            document_id: queryTrainingDataList[i].documentId,
            relevance: queryTrainingDataList[i].relevance
        });
    }
    return data;
};

function main(args) {
    setupGlobalVariables(args);
    log(args);
    var payload = JSON.parse(args.payload);
    log(payload);
    log('actions:');
    log(payload.actions);

    return new Promise(function(resolve, reject) {

        var queryTrainingDataList = JSON.parse(payload.actions[0].value);
        if (queryTrainingDataList.type != null) {
            log('type not null');
            if (queryTrainingDataList.type == 'echo') {
                log('echo');

                var cloudant_id = queryTrainingDataList.cloudant_id;

                var queryDatabase = cloudant.use(cloudantDbName);

                queryDatabase.get(cloudant_id, function(err, data) {
                    if (err) {
                        log('get error: ', err);
                    } else {
                        log('upload time: ', data.upload_time);
                        data.originalEventObject.ts = queryTrainingDataList.ts;
                        log('ts: ' + data.originalEventObject.ts);
                        postMessageAdvanced(data.originalEventObject, slackbotAccessToken, data.user_channel_id, data.text, data.attachments, function(err, response, messageBody) {
                            log('postMessageAdvanced callback:');
                            if (err) {
                                log('postMessageAdvanced error: ', err);
                                resolve({body:'eh'});
                                /*statusCode: 500, 
                                    error: err,
                                    result: messageBody
                                });*/
                            }
                            log('yes yes');

                            resolve({});
                            return;
                        });
                    }
                });
                return;
            }
        }

        var document_id = queryTrainingDataList[0].documentId;
        var query = queryTrainingDataList[0].query;
        

        log('query training data list');
        log(JSON.stringify(queryTrainingDataList));

        log(query);
        log(document_id);
        
        var options = { method: 'POST',
            url: 'https://gateway.watsonplatform.net/discovery/api/v1/environments/' + discoveryEnvironmentId + '/collections/' + discoveryCollectionId + '/training_data',
            qs: { version: discoveryApiVersionDate },
            headers:
        { 'content-type': 'application/json',
            authorization: 'Basic ' + new Buffer(discoveryUsername + ':' + discoveryPassword).toString('base64') 
        },
            body:
        { 
            natural_language_query: query,
            examples: getDocumentIdRelevance(queryTrainingDataList) 
        },
            json: true 
        };

        
        var originalPassageText = '', originalPassageScore = '', relevance = '', srcUrl = '';
        log('promise');
        log(JSON.stringify(payload.channel));
        log(payload.channel.id);
        args.event = {
            channel: payload.channel.id
        };
        args.team_id = payload.user.team_id;
        args.text = query;
        args.token = args.slackVerificationToken;
        args.type = 'event';

        log('promise part 2');

        request(options, function (error, response, body) {
            if (error) {
                log('request 1 error: ' + error);
                throw new Error(error);
            }
            log('body: ' + JSON.stringify(body));

            if (queryTrainingDataList.length == 1) {
                originalPassageText = queryTrainingDataList[0].passage_text;
                originalPassageScore = queryTrainingDataList[0].passage_score;
                relevance = queryTrainingDataList[0].relevance;
                srcUrl = queryTrainingDataList[0].documentUrl;
            }

            log(response.statusCode);

            // no 409 = the training query was not entered previously
            if (response.statusCode != 409) {
                log('no 409, returning');
                if (queryTrainingDataList.length == 1) {
                    resolve ({body: srcUrl + `\n\`\`\`${originalPassageText}\`\`\``});
                } else if (queryTrainingDataList.length > 1) {
                    log('multiple training data');
                    var documents = getDocumentIdRelevance(queryTrainingDataList);
            
                    for(var i=0; i < documents.length; i++) {
                        options.body = {
                            document_id: documents[i].document_id,
                            relevance: documents[i].relevance
                        };
                        request(options, function (error2, response2, body2) {
                            if (error2) {
                                log(error2);
                                resolve({body: error2});
                            }
                            log(body2);
                            return;
                        });
                    }
  
                    resolve ({body: apologyResponse});
                } else {
                    resolve ({body: 'Thanks...'});
                }
                return;
            }

            log('trying to add example doc to existing query');
            log('body.error: ');
            log(body.error);
            var query_id = findQueryId1(body.error);
            if (query_id.length == 0) {
                query_id = findQueryId(body.error);
                if (query_id.length == 0) {
                    log('query_id is empty');
                    resolve({body: '!! error adding example document to existing query'});
                }
            }
            log('query_id: ' + query_id);
            options.url += '/' + query_id + '/examples';

            if (queryTrainingDataList.length == 1) {
                options.body = {
                    document_id: document_id,
                    relevance: relevance
                };
                request(options, function (error2, response2, body2) {
                    if (error2) {
                        log(error2);
                        resolve({body: error2});
                    }
                    log(body2);
                    resolve ({body: `\`\`\`${originalPassageText}\`\`\`` + '\n' + srcUrl + ' | ' + originalPassageScore.toFixed(3)});

                    return;
                });
            } else {
                log('multiple training data');
                var documents = getDocumentIdRelevance(queryTrainingDataList);
          
                for(var i=0; i < documents.length; i++) {
                    options.body = {
                        document_id: documents[i].document_id,
                        relevance: documents[i].relevance
                    };
                    request(options, function (error2, response2, body2) {
                        if (error2) {
                            log(error2);
                            resolve({body: error2});
                        }
                        log(body2);
              
                        return;
                    });
                }

                resolve ({body: apologyResponse});
            }
        });

      
    });  
}

/**
 * Posts a message to a channel with Slack Web API
 *
 * @param accessToken - authorization token
 * @param channel - the channel to post to
 * @param text - the text to post
 * @param callback - function(err, responsebody)
 */
function postMessageAdvanced(originalEventObject, accessToken, user_channel_id, text, attachments, callback) {
    let thread_ts = originalEventObject.ts;
    if (originalEventObject.hasOwnProperty('thread_ts')) {
        thread_ts = originalEventObject.thread_ts;
    }
    request({
        url: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        form: {
            token: accessToken,
            channel: user_channel_id,
            'text': text,
            'attachments': JSON.stringify(attachments),
            thread_ts: thread_ts
        }
    }, function(error, response, body) {
        callback(error, response, body);
    });
}