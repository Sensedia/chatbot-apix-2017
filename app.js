'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request'),
  dateFormat = require('dateformat'),
  phone = require('node-phonenumber'),
  NodeCache = require('node-cache');

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

const PRODUCT_URL = (process.env.PRODUCT_URL) ?
  (process.env.PRODUCT_URL) :
  config.get('productUrl');

const PHONE_URL = (process.env.PHONE_URL) ?
  (process.env.PHONE_URL) :
  config.get('phoneUrl');

const API_CLIENT_ID = (process.env.API_CLIENT_ID) ?
  (process.env.API_CLIENT_ID) :
  config.get('apiClientID');

const CACHE = new NodeCache();

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
              } else if (messagingEvent.postback) {
                receivedPostback(messagingEvent);
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

app.get("/image/:productId", function(req, res) {

    request({
      uri: PRODUCT_URL + '/products/' + req.params.productId + '/images',
      headers: {'client_id': API_CLIENT_ID},
      method: 'GET'
    }, function (error, response, body) {
          
          var img = new Buffer(JSON.parse(body).data, 'base64');

          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': img.length
          });

          res.end(img);
    });
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

function receivedPostback(event) {
    
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;
    var payload = event.postback.payload;

    console.log("Postback. Usuário %d | Página %d | Payload '%s' | Time %d", senderID, recipientID, payload, timeOfPostback);

    parsePostback(event.postback.payload, senderID);
}

function parsePostback(postback, senderID) {

      switch(postback) {

        case 'COMPRAR_SIM':
          getPhone(senderID);
        break;

        case 'INFORMAR_TEL_SIM':
          // Encaminha para pagamento
        break;

        case 'INFORMAR_TEL_NAO':
          sendPhoneMessage(senderID, "Informe o telefone para cadastro.");
        break;

        case 'NOTIFICAR_SIM':
          sendProductNotification(senderID);
          sendTextMessage(senderID, "Ok, avisaremos quando encontrar");
        break;

        case 'NOTIFICAR_NAO':
          sendTextMessage(senderID, "Tudo bem, volte sempre!");
        break;

        default:
          sendGenericErrorMessage(senderID);
      }
}

function searchProduct(product, senderID) {

    request({
      uri: PRODUCT_URL + '/products/',
      headers: { 'client_id': API_CLIENT_ID },
      qs: { name: product},
      method: 'GET'
    }, function (error, response, body) {      

          if (!error && response.statusCode == 200 && JSON.parse(body).length > 0) {
              sendTextMessage(senderID, product + ' encontrado!');
              sendProductMessage(senderID, JSON.parse(body)[0]);
           } else {
              sendErrorMessage(senderID, "Produto não encontrado no momento.");
              sendNotificationButton(senderID);
           }
    });
}

function sendProductMessage(recipientId, product) {

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: product.name,
            subtitle: product.installment,
            image_url: SERVER_URL + "/image/" + product.productId,
            buttons: [{
              type: "postback",
              title: "Comprar",
              payload: "COMPRAR_SIM",
            }],
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendProductNotification(senderID) {

    var flow = loadFlowCache(senderID);

    request({
      uri: PRODUCT_URL + '/notifications',
      headers: {'content-type': 'application/json',
                'client_id': API_CLIENT_ID},
      method: 'POST',
      json: true,
      body: {"product": flow.productName, "senderId": senderID, "callback": SERVER_URL + "/notification"}
    }, function (error, response, body) {
        console.log('Notificação registrada');
    });
}

app.post('/notification', function (req, res) {

    request({
      uri: PRODUCT_URL + '/products/' + req.body.product,
      headers: {'client_id': API_CLIENT_ID},
      method: 'GET'
    }, function (error, response, body) {      

          if (!error && response.statusCode == 200 && body ) {
              sendTextMessage(req.body.senderId, 'Encontramos seu produto!');
              sendGenericMessage(req.body.senderId, JSON.parse(body));

              console.log('Notificação recebida');
           }

           res.sendStatus(200);
    });
});

function sendPhoneMessage(senderID) {
  sendTextMessage(senderID, "Informe o telefone");
}

function getPhone(senderID) {
  
    request({
      uri: PHONE_URL + '/usuarios/' + senderID + '/telefones',
      headers: {'client_id': API_CLIENT_ID},
      method: 'GET'
    }, function (error, response, body) {

          if (!error && response.statusCode == 200 && body) {
            
            var bodyParsed;

            if(body) {
                bodyParsed = JSON.parse(body);
            }

            if(body && bodyParsed && bodyParsed.length > 0) {
              
              var flow = loadFlowCache(senderID);
              flow.phone = bodyParsed[0].numero;
              
              saveFlowCache(senderID, flow);

              sendPhoneButtonMessage(senderID, bodyParsed[0]);

            } else {

              sendPhoneMessage(senderID, "Informe o telefone para cadastro.");
            }
          }
    });
}

function sendPhoneButtonMessage(senderID, phoneNumber) {

  var messageData = {
    recipient: {
      id: senderID
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Você possui o telefone " + phoneNumber.numero + " cadastrado. Deseja utilizar o mesmo?",
          buttons:[{
            type: "postback",
            title: "Sim",
            payload: "INFORMAR_TEL_SIM"
          }, {
            type: "postback",
            title: "Não",
            payload: "INFORMAR_TEL_NAO"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

function savePhone(senderID, phoneNumber) {

    var payload = {};
    payload.numero = phoneNumber; 

    request({
      uri: PHONE_URL + '/usuarios/' + senderID + '/telefones',
      method: 'POST',
      headers: {'client_id': API_CLIENT_ID},
      json: payload
    }, function (error, response, body) {          
          if (!error && response.statusCode == 201 && body) {

              var flow = loadFlowCache(senderID);
              flow.phone = phoneNumber;

              saveFlowCache(senderID, flow);

              console.log(">> PHONE SAVE");
              
          } else {
              console.error(body);
          }
    });
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

function sendNotificationButton(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Quer que continuemos procurando e avisamos quando encontrar?",
          buttons:[{
            type: "postback",
            title: "Sim",
            payload: "NOTIFICAR_SIM"
          }, {
            type: "postback",
            title: "Não",
            payload: "NOTIFICAR_NAO"
          }]
        }
      }
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
      
        switch(intent.value) {
        
          case 'greetings':
             sendTextMessage(senderID, "Olá, seja bem vindo.");
             return; 

          case 'buy':

             if(message.product && message.product.length > 0) {
                searchProduct(message.product[0].value, senderID);
             }

             return;
          
          case 'phone':

             if(message.phone_number && message.phone_number.length > 0) {
  
                var phoneUtil = phone.PhoneNumberUtil.getInstance();
                var phoneNumber = phoneUtil.parse(message.phone_number[0].value,'BR');
                var toNumber = phoneUtil.format(phoneNumber, phone.PhoneNumberFormat.E164);
 
                console.log(toNumber);

                savePhone(senderID, toNumber);
             }

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

function loadFlowCache(senderID) {

  var flow = CACHE.get(senderID);

  if ( !flow ){
    flow = {};
  }

  return flow;  
}

function saveFlowCache(senderID, flow) {
    CACHE.set(senderID, flow);
}

app.listen(app.get('port'), function() {
  console.log('ChatBot está em execução na porta ', app.get('port'));
});

module.exports = app;