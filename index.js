const functions = require('firebase-functions');
const admin = require('firebase-admin');
const rp = require('request-promise');

admin.initializeApp(functions.config().firebase);

let categoryToEmojiMapping = null;
let projectToChannelMapping = null;
let db = admin.firestore();
db.settings({ timestampsInSnapshots: true });

function authorizeRequest(req, res) {
    const providedToken = req.get('octolog-token');
    const token = functions.config().octolog.authtoken;

    if (!providedToken || providedToken !== token) {
        return Promise.reject({
            code: 401,
            message: 'Missing or invalid token'
        });
    }

    return Promise.resolve([req, res]);
}

function getPayload([req, res]) {
    const payload = req.body.Payload;

    if (payload) {
        return Promise.resolve(payload);
    }

    return Promise.reject({
        code: 400,
        message: 'No payload provided'
    });
}

function loadMappings(payload) {
    if (categoryToEmojiMapping && projectToChannelMapping) {
        return Promise.resolve([payload, categoryToEmojiMapping, projectToChannelMapping]);
    }
 
    const collection = db.collection("mappings");
    const categoryToEmojiPromise = collection.doc('categoryToEmoji').get();
    const projectToChannelPromise = collection.doc('projectToChannel').get();

    return Promise.all([categoryToEmojiPromise, projectToChannelPromise])
        .then(([categoryToEmojiDoc, projectToChannelDoc]) => {
            categoryToEmojiMapping = categoryToEmojiDoc.data();
            projectToChannelMapping = projectToChannelDoc.data();

            return [payload, categoryToEmojiMapping, projectToChannelMapping];
        });
}

function createSlackOptions([payload, categoryToEmoji, projectToChannel]) {
    const projectId = payload.Event.RelatedDocumentIds.find(id => id.startsWith('Projects-'));
    const channel = projectToChannel[projectId];
    const emoji = categoryToEmoji[payload.Event.Category];

    return {
        "channel": channel,
        "text": `${emoji} ${payload.Event.Message} ${emoji}`,
        "username": `Octopus Subscription: ${payload.Subscription.Name}`
    };
}

function sendSlackMessage(options) {
    const slackUri = functions.config().slack.uri;

    const requestOptions = {
        method: 'POST',
        uri: slackUri,
        body: {
            "channel": options.channel,
            "username": options.username,
            "icon_emoji": ":octopusdeploy:",
            "text": options.text
        },
        json: true
    }

    return rp(requestOptions);
}

function checkForDuplicate(payload) {
    return db.runTransaction((transaction) => {
        const eventReference = db.collection("deployments").doc(payload.Event.Id);

        return transaction.get(eventReference).then((eventDoc) => {
            if (eventDoc.exists) {
                return Promise.reject({
                    code: 200,
                    message: `Event ${payload.Event.Id} has already been processed.`
                });
            }

            transaction.set(eventReference, payload);
            console.log("Document written with ID: ", payload.Event.Id);

            return payload;
        });
    });
}

function handleRejection(res, reason) {
    if (reason.message) {
        console.warn(reason.message);
        return res.status(reason.code).send(reason.message);
    }

    console.warn(reason);
    return res.status(400).send();
}

exports.logOctopusEvent = functions.https.onRequest((req, res) => {
    const sendOkResponse = () => { return res.status(200).send(); };
    const callHandleRejection = (reason) => {
        return handleRejection(res, reason);
    }

    return authorizeRequest(req, res)
        .then(getPayload)
        .then(checkForDuplicate)
        .then(loadMappings)
        .then(createSlackOptions)
        .then(sendSlackMessage)
        .then(sendOkResponse)
        .catch(callHandleRejection);
});
