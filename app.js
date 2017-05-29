'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request'),
  dateFormat = require('dateformat');

var app = express();

app.set('port', process.env.PORT || 5000);
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

const WIT_TOKEN = (process.env.WIT_TOKEN) ?
  (process.env.WIT_TOKEN) :
  config.get('witAccessToken');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL && WIT_TOKEN)) {
  console.error("Configurações não informadas");
  process.exit(1);
}

app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
   
    console.log("Validando webhook");

    res.status(200).send(req.query['hub.challenge']);

  } else {
    console.error("Falha na validação. Verifique o token e tente novamente");
    res.sendStatus(403);          
  }  
});

app.post('/webhook', function (req, res) {

  var data = req.body;

  if (data.object == 'page') {

      data.entry.forEach(function(pageEntry) {
      
          var pageID = pageEntry.id;
          var timeOfEvent = pageEntry.time;

          pageEntry.messaging.forEach(function(messagingEvent) {
              if (messagingEvent.message) {
                receivedMessage(messagingEvent);
              }
          });
      });
  }

  res.sendStatus(200);
});

app.get('/status', function(req, res) {
    res.writeHead(200, {"Content-Type": "text/plain"});
    res.end("Status: OK");
});

function receivedMessage(event) {
  
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;

  console.log("Mensagem recebida. Usuário: %d | Pagina %d | Time %d. Mensagem: ", senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var message = event.message;

  var messageText = message.text;
  var messageAttachments = message.attachments;

  if (messageText) {
     callWit(messageText, senderID);
  } else if (messageAttachments) {
     sendErrorMessage(senderID, "No momento não aceitamos mensagens com anexo");
  }
}

function sendErrorMessage(senderID, message) {
    sendTextMessage(senderID, message);
}

function sendGenericErrorMessage(senderID) {
    sendTextMessage(senderID, "Não conseguimos entender.");
}

function sendTextMessage(recipientId, messageText) {
  
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "TEXT_MESSAGE"
    }
  };

  callSendAPI(messageData);
}

function callWit(message, senderID) {

  request({
      uri: 'https://api.wit.ai/message',
      headers: { 'Authorization': 'Bearer ' + WIT_TOKEN },
      qs: { q: message, v: dateFormat(new Date(), "dd/m/yyyy")},
      method: 'GET',
      json: message
    }, function (error, response, body) {
        
          console.log(">>> WIT");
          console.log(body);

          if (!error && response.statusCode == 200 && body 
              && body.entities && body.entities.intent && body.entities.intent.length > 0) {

             parseMessageWit(body.entities, senderID);
          } else {
             sendGenericErrorMessage(senderID);
             return;
          }
    }); 
}

function parseMessageWit(message, senderID) {

    message.intent.forEach(function(intent) {

        console.log(">>>> Intent");
        console.log(intent);
        console.log(">>>> Value");
        console.log(intent.value);
      
        switch(intent.value) {
        
          case 'greetings':
             sendTextMessage(senderID, "Olá, seja bem vindo.");
             return; 
        }

        sendGenericErrorMessage(senderID);
    });
}

function callSendAPI(messageData) {
    
    request({
      uri: 'https://graph.facebook.com/v2.9/me/messages',
      qs: { access_token: PAGE_ACCESS_TOKEN },
      method: 'POST',
      json: messageData

    }, function (error, response, body) {
      
      if (!error && response.statusCode == 200) {
        
        var recipientId = body.recipient_id;
        var messageId = body.message_id;

        if (messageId) {
          console.log("Mensage %s enviada para  %s", messageId, recipientId);
        } else {
          console.log("Mensagem enviada para %s", recipientId);
        }
      } else {
        console.error("Falha ao enviar mensagem", response.statusCode, response.statusMessage, body.error);
      }
    });  
}

function verifyRequestSignature(req, res, buf) {
  
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    console.error("Não foi possível validar a assinatura da requisição");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Não foi possível validar a assinatura da requisição");
    }
  }
}

app.listen(app.get('port'), function() {
  console.log('ChatBot está em execução na porta ', app.get('port'));
});

module.exports = app;