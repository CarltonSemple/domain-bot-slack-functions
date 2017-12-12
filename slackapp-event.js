'use-strict';

const request = require('request');
const watson = require('watson-developer-cloud');
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

/**
 * Instantiate the Watson Conversation Service
 */
var conversation;
var conversationWorkspaceId = '';

var setupGlobalVariables = (args) => {
    discoveryEnvironmentId = args.discoveryEnvironmentId;
    discoveryCollectionId = args.discoveryCollectionId;
    discoveryUsername = args.discoveryUsername;
    discoveryPassword = args.discoveryPassword;
    slackbotAccessToken = args.slackbotAccessToken;
    conversation = new watson.ConversationV1({
        username: args.conversationUsername,
        password: args.conversationPassword,
        version_date: watson.ConversationV1.VERSION_DATE_2016_09_20
    });
    conversationWorkspaceId = args.conversationWorkspaceId;
    cloudant = Cloudant({url: args.cloudantUrl});
    cloudantDbName = args.cloudantDb;
};

var main = (args) => {
    setupGlobalVariables(args);
    console.log(args.__ow_body);
    log('before body');
    var body = JSON.parse(new Buffer(args.__ow_body, 'base64').toString());
    console.log(body);
    log('after body');
    log('event: ', body.event);

    if (body) {
        // handle the registration of the Event Subscription callback
        // Slack will send us an initial POST
        // https://api.slack.com/events/url_verification
        if (body.type === 'url_verification' && body.challenge) {//(slackTokens.indexOf(body.token) > -1) && body.challenge) {
            console.log('URL verification from Slack');
            return {
                headers: {
                    'Content-Type': 'application/json'
                },
                body: {
                    challenge: JSON.stringify({challenge: body.challenge})
                }
            };
        }
    }

    if(body.event.hasOwnProperty('subtype')) {
        if(body.event.subtype == 'bot_message') {
            return {
                statusCode: 200,
                body: 'BOT'
            };
        }
    }
    
    if(args.__ow_headers['x-slack-retry-num']){
        log('retry num ');
        let retryNum = parseInt(args.__ow_headers['x-slack-retry-num'],10);
        log(retryNum);
        if (retryNum > 0)
            return  {
                statusCode: 200,
                body: 'IGNORE RETRYS'
            };
    }

    log('bot...id: ' + body.authed_users);
    let bot_mention_id = body.authed_users[0];
    // only respond to messages that mention the bot
    if (body.event.text) {
        if (body.event.text.indexOf(bot_mention_id) < 0) {
            return  {
                statusCode: 200,
                body: 'bot not mentioned'
            };
        } else if (body.event.text.indexOf('joined the channel') >= 0) {
            return  {
                statusCode: 200,
                body: 'ignoring \'joined the channel\''
            };
        } else if ((body.event.text.indexOf('joined') >= 0) && (body.event.text.indexOf('by invitation from') >= 0)) {
            return  {
                statusCode: 200,
                body: 'ignoring \'joined by invitation from\''
            };
        }
        body.event.text = body.event.text.replace('<@'+ bot_mention_id + '>', '');
    }

    //log(JSON.stringify(body));
    if (!body.event.text) {
        return  {
            statusCode: 200,
            body: 'empty text'
        };
    } else if (body.event.text.length == 0) {
        return  {
            statusCode: 200,
            body: 'empty text'
        };
    }

    body.type = 'event';
  
    // the command to process
    let command = {
        team_id: body.team_id,
        text: body.event.text,
        user_channel_id: body.event.channel
    };
  
    if (!command.text) {
        return {statusCode: 500, message: 'text undefined'};
    }

    if(body.event.user_profile) {
        log('user: ' + body.event.user_profile.first_name);
    }

    return interactWithConversationAndDiscovery(body);
};

var interactWithConversationAndDiscovery = (slackRequestBody) => {
    return new Promise(function(resolve, reject) {
        let body = slackRequestBody;
        let command = {
            team_id: body.team_id,
            text: body.event.text,
            user_channel_id: body.event.channel
        };
        let first_name = '';
        if (body.event.user_profile) {
            first_name = body.event.user_profile.first_name;
        }
        messageConversation(body.event.text, {
            username: first_name
        }).catch(rejectVal => {
            log('conversation error: ', JSON.stringify(rejectVal.message));
            log(rejectVal.message);
            log(JSON.stringify(rejectVal));
            postMessage(body.event, slackbotAccessToken, 
                body.event.channel, 
                'Uh oh! My smarter side didn\'t catch that. Let\'s see what we can find...'
            );
            //resolve({body:'conversation error'});
        }).then(conversationResponse => {
            // default to search unless conversationResponse exists and says otherwise
            if (conversationResponse) {
                log('conversation response: ', JSON.stringify(conversationResponse));          
                log('about to send initial response');
                if (conversationResponse.output.text[0]) {
                    log(conversationResponse.output.text[0]);
                    postMessage(body.event, slackbotAccessToken, 
                        body.event.channel, 
                        conversationResponse.output.text[0]
                    );
                } else {
                    log('no conversation response');
                    postMessage(body.event, slackbotAccessToken, 
                        body.event.channel, 
                        'Uh oh! My smarter side didn\'t catch that. Let\'s see what we can find...'
                    );
                }

                if (conversationResponse.output.action) {
                    if (conversationResponse.output.action != 'search') {
                        var sleep = require('sleep');
                        sleep.sleep(2);                        
                        resolve({body:'conversation said to not search'});
                        return;
                    }
                } else {
                    log('conversation response -> output -> action not defined');
                }
            }
            
            log('searching');
            callDiscovery(command).catch(rejectVal => {
                log('rejectVal: ', rejectVal);
            }).then((discoveryStuff) => {
                handleDiscoveryResponse(body.event, discoveryStuff.replyMessage, discoveryStuff.body, discoveryStuff.command, 
                    function(err, response, messageBody) {
                        console.log('handleDiscoveryResponse callback:');
                        if (err) {
                            log(err);
                            handleDiscoveryResponse(body.event, discoveryStuff.replyMessage, discoveryStuff.body, discoveryStuff.command, 
                                function(err, response, messageBody) {
                                    console.log('handleDiscoveryResponse callback:');
                                    if (err) {
                                        resolve({
                                            statusCode: 500, 
                                            error: err,
                                            result: messageBody
                                        });
                                    }
                                    resolve({body:'yes'});
                                });
                        } else {
                            resolve({body:'no'});
                        }
                    });
            });
            log('end');

        });
        log('outer end');
    });
};

/**
 * Calls the conversation message api.
 * returns a promise
 */
const messageConversation = function(text, context) {
    const payload = {
        workspace_id: conversationWorkspaceId,
        input: {
            text: text
        },
        context: context
    };
    return new Promise((resolve, reject) =>
        conversation.message(payload, function(err, data) {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        })
    );
};

/**
 * Posts a message to a channel with Slack Web API
 *
 * @param accessToken - authorization token
 * @param channel - the channel to post to
 * @param text - the text to post
 * @param callback - function(err, responsebody)
 */
function postMessage(originalEventObject, accessToken, channel, text) {
    let thread_ts = originalEventObject.ts;
    if (originalEventObject.hasOwnProperty('thread_ts')) {
        thread_ts = originalEventObject.thread_ts;
    }
    request({
        url: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        form: {
            token: accessToken,
            channel: channel,
            text: text,
            thread_ts: thread_ts
        }
    }, function(err, response, body) {
        console.log('postMessage request callback');
        if(err) {
            console.log('error: ' + err);
        }
    });
}

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
        console.log('postMessageAdvanced results:');
        callback(error, response, body);
    });
}

var handleDiscoveryResponse = (originalEventObject, replyMessage, body, command, callback) => {
    log('handleDiscoveryResponse');
    var positiveActions = [];
    var documentIdsAndUrls = {};
    var allNegativeAction = [];
    var moreActions = [];

    log('inquiry: ' + command.text);

    // make document ID-URL dictionary
    log(body.results.length + ' results');
    for(let i = 0; i < body.results.length; i++) {
        documentIdsAndUrls[body.results[i].id] = body.results[i].metadata.srcUrl;
    }

    let moreAnswersMessage = '';

    for(let i = 0; i < body.passages.length && i <= 4; i++) {
        let item = body.passages[i];
        let index = i;
        var docURL = 'Sorry, no URL available';
        if(item.document_id in documentIdsAndUrls) {
            docURL = documentIdsAndUrls[item.document_id];
        }
        //docURL = transformToURL(docURL);

        console.log(item);

        if (i < 2) {
            replyMessage += '\n\n\n' 
            + (index+1) + ' '
            + `\`\`\`${item.passage_text}\`\`\``
            + '\n' + docURL
            + ' | ' + item.passage_score.toFixed(3);
        } else {
            moreAnswersMessage += '\n\n\n' 
            + (index+1) + ' '
            + `\`\`\`${item.passage_text}\`\`\``
            + '\n' + docURL
            + ' | ' + item.passage_score.toFixed(3);
        }

        let numText = index + 1;

        // thumbs-up
        positiveActions.push({
            value: JSON.stringify([{
                documentId: item.document_id,
                documentUrl: docURL,
                query: command.text,
                relevance: 10,
                passage_score: item.passage_score,
                passage_text: item.passage_text
            }]),
            name: command.text,
            type: 'button',
            text: numText.toString()
        });

        // negative option
        allNegativeAction.push(
            {
                documentId: item.document_id,
                //documentUrl: docURL,
                query: command.text,
                relevance: 0,
                //passage_score: item.passage_score,
                //passage_text: item.passage_text
            }
        );
    }

    var attachments = [
        {
            'text': 'Can you help me improve my accuracy? Which answer was best?',
            'fallback': 'You are unable to pick',
            'callback_id': 'wopr_game',
            'color': '#3AA3E3',
            'attachment_type': 'default',
            'actions': positiveActions
        },
        {
            'text': ' ',
            'fallback': 'You are unable to pick',
            'callback_id': 'wopr_game',
            'color': '#3AA3E3',
            'attachment_type': 'default',
            'actions': [{
                value: JSON.stringify(allNegativeAction),
                name: command.text,
                type: 'button',
                text: 'None of the answers are good'
            }]
        }
    ];

    // save query response to cloudant
    var queryDatabase = cloudant.use(cloudantDbName);
    let date = new Date();
    let messageData = {
        upload_time: date.getTime(),
        originalEventObject: originalEventObject,
        user_channel_id: command.user_channel_id,
        text: moreAnswersMessage,
        attachments: attachments
    };

    let cloudant_id = command.text;
    cloudant_id = cloudant_id.toLowerCase().replace(/[^a-zA-Z0-9]+/g, '-');

    queryDatabase.get(cloudant_id, function(err, body) {
        if (!err) {
            var latestRev = body._rev;
            queryDatabase.destroy(cloudant_id, latestRev, function(err, body, header) {
                if (!err) {
                    console.log('Successfully deleted doc', cloudant_id);
                    queryDatabase.insert(messageData, cloudant_id, function(err, body, header) {
                        if (err) {
                            log('insert error');
                        } else {
                            log('message data inserted');
                        }
                    });
                }
            });
        }
    });
    queryDatabase.insert(messageData, cloudant_id, function(err, body, header) {
        if (err) {
            log('insert error');
        } else {
            log('message data inserted');
        }
    });

    let thisAttachmentSet = [
        {
            'text': ' ',
            'fallback': 'You are unable to pick',
            'callback_id': 'wopr_game',
            'color': '#3AA3E3',
            'attachment_type': 'default',
            'actions': [{
                value: JSON.stringify({
                    type: 'echo',
                    query: command.text,
                    cloudant_id: cloudant_id,
                    ts: originalEventObject.ts
                }),
                name: command.text,
                type: 'button',
                text: 'More answers'
            }]
        }
    ];

    postMessageAdvanced(originalEventObject, slackbotAccessToken, command.user_channel_id, replyMessage, thisAttachmentSet, callback);
};

var callDiscovery = (command) => {
    log('inside calldiscovery');
    return new Promise(function(thisResolve, reject) {
        log('call Discovery');
        var replyMessage = 'top results for `' + command.text + '`:';
  
        let options = {
            method: 'GET',
            url: 'https://gateway.watsonplatform.net/discovery/api/v1/environments/' + discoveryEnvironmentId + '/collections/' + discoveryCollectionId + '/query',
            qs: {
                version: discoveryApiVersionDate,
                count: 25,
                passages: 'true',
                'passages.characters': 400,
                highlight: 'true',
                return: 'metadata',
                natural_language_query: command.text
            },
            headers: {
                authorization: 'Basic ' + new Buffer(discoveryUsername + ':' + discoveryPassword).toString('base64'),
                'content-type': 'application/json'
            }
        };
  
        log('sending request to discovery');
        request(options, function(error, response, body) {
            log('discovery response');
            if (error) {
                log(error);
                throw new Error(error);
            }

            var bodyObj = JSON.parse(body);
                    
            thisResolve({
                replyMessage: replyMessage,
                body: bodyObj,
                command: command
            });
        });
    });
};