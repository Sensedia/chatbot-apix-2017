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

const PAYMENT_URL = (process.env.PAYMENT_URL) ?
  (process.env.PAYMENT_URL) :
  config.get('paymentUrl');

const SMS_URL = (process.env.SMS_URL) ?
  (process.env.SMS_URL) :
  config.get('smsUrl');

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

app.get('/finish', function (req, res) {

    var senderID = req.query.senderID;

    if(senderID) {
      var flow = loadFlowCache(senderID);
      sendSMS(senderID, flow.phone, flow.username);
    }

    res.sendStatus(200);
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

    var quickReply = message.quick_reply;

   if (quickReply) {
     
      var quickReplyPayload = quickReply.payload;
      console.log("Resposta rápida:  Mensagem: %s | Payload:  %s", messageId, quickReplyPayload);  
      
      switch(quickReplyPayload) {
        case 'BOM':
            sendTextMessage(senderID, 'Obrigado');
          break;

          case 'MUITO_BOM':
            sendTextMessage(senderID, 'Muito Obrigado');
          break;

          case 'EXTRAORDINARIO':
            sendTextMessage(senderID, 'Muito Obrigado Mesmo!');
          break;
      }

      return;
    }

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
          getUserName(senderID, getPhone);
        break;

        case 'INFORMAR_TEL_SIM':
          sendPaymentMessage(senderID);
        break;

        case 'INFORMAR_TEL_NAO':
          sendPhoneMessage(senderID, "Informe o telefone para cadastro.");
        break;

        case 'PAGAMENTO_CIELO':
          generateReceiptCielo(senderID);
        break;

        case 'PAGAMENTO_VISA':
          generateReceiptVisa(senderID);
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

  var flow = loadFlowCache(recipientId);
  flow.productId = product.productId;
  flow.productName = product.name;
  flow.productInstallment = product.installment;
  flow.productPrice = product.value;
  
  saveFlowCache(recipientId, flow);

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

              sendPaymentMessage(senderID);
              
          } else {
              console.error(body);
          }
    });
}

function sendPaymentMessage(senderID) {
    
    var messageData = {
    recipient: {
      id: senderID
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Qual a forma de pagamento desejada?",
          buttons:[{
            type: "postback",
            title: "Visa",
            payload: "PAGAMENTO_VISA"
          }, {
            type: "postback",
            title: "Cielo LIO",
            payload: "PAGAMENTO_CIELO"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

function generateReceiptCielo(senderID) {
   generateReceipt(senderID, 'CIELO_LIO');
}

function generateReceiptVisa(senderID) {
   generateReceipt(senderID, 'VISA_CHECKOUT');
}

function generateReceipt(senderID, method) {
    
    var flow = loadFlowCache(senderID);

    var json = {};
    json.paymentProvider = method;
    json.amount = 3;
    json.remoteID = senderID;
    json.callbackUrl = SERVER_URL + '/finish?senderId=' + senderID;
    json.item = flow.productName;

    request({
        uri: PAYMENT_URL + '/payments',
        method: 'POST',
        headers: {'client_id': API_CLIENT_ID},
        json: json
      }, function (error, response, body) {          

          if (!error && response.statusCode == 201 && body) {
              sendReceiptMessage(senderID, json.item, flow.productPrice, method, flow.productId, 
                flow.productInstallment, flow.username);

                if (method == 'VISA_CHECKOUT') {
                  sendVisaCheckoutButtonMessage(senderID, body.paymentID);
                }
          
          } else {
              console.log('Error sending payment');
          }
    });
}

function sendReceiptMessage(recipientId, product, price, method, productId, productInstallment, username) {

  var timestamp = Math.round(new Date() / 1000);
  var priceFixed = price.toFixed(2);

  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: username,
          order_number: receiptId,
          currency: "BRL",
          payment_method: method,        
          timestamp: timestamp, 
          elements: [{
            title: product,
            subtitle: productInstallment,
            quantity: 1,
            price: priceFixed,
            currency: "BRL",
            image_url: SERVER_URL + "/image/" + productId
          }],
          address: {
            street_1: "Av. 1",
            street_2: "",
            city: "São Paulo",
            postal_code: "13000-000",
            state: "SP",
            country: "BR"
          },
          summary: {
            subtotal: priceFixed,
            shipping_cost: 0.00,
            total_tax: 0.00,
            total_cost: priceFixed
          },
          adjustments: []
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendVisaCheckoutButtonMessage(senderID, paymentID) {

  var messageData = {
    recipient: {
      id: senderID
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Clique no botão abaixo para efetuar o pagamento",
          buttons:[{
            type: "web_url",
            title: "Visa Checkout",
            url: VISA_CHECKOUT_URL + '?id=' + paymentID
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

function getUserName(senderID, cb) {

  request({
    uri: 'https://graph.facebook.com/v2.9/' + senderID + '/',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'GET'
  }, function (error, response, body) {

    if (!error && response.statusCode == 200) {

        var flow = loadFlowCache(senderID);

        var userProfile = JSON.parse(body);
        flow.username = userProfile.first_name + ' ' + userProfile.last_name;
        saveFlowCache(senderID, flow);

        cb(senderID, flow.username);
        
    } else {
      console.error("Failed calling Graph API", response.statusCode, response.statusMessage, body.error);
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

function sendSMS(senderID, phone, username) {
    
    var sendSmsRequest = {};
    sendSmsRequest.from = "APIX 2017";
    sendSmsRequest.to = phone;
    sendSmsRequest.msg = username + ", seu pagamento foi efetuado com sucesso!";
    sendSmsRequest.callbackOption = "FINAL";

    var json = {};
    json.sendSmsRequest = sendSmsRequest;

    request({
        uri: SMS_URL + '/sms',
        method: 'POST',
        headers: {'client_id': API_CLIENT_ID, 
                  'content-type': 'application/json'},
        json: json
      }, function (error, response, body) {          
          if (!error && response.statusCode == 200 && body) {
              sendSurveyMessage(senderID);
          } else {
              console.log('Error sending sms');
          }
    });
}

function sendSurveyMessage(recipientId) {

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Obrigado por utilizar nossos serviços. Como você avalia sua compra?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Bom",
          "payload":"BOM"
        },
        {
          "content_type":"text",
          "title":"Muito Bom",
          "payload":"MUITO_BOM"
        },
        {
          "content_type":"text",
          "title":"Extraordinário",
          "payload":"EXTRAORDINARIO"
        }
      ]
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
             getUserName(senderID, sendWelcomeMessage);
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

function sendWelcomeMessage(senderID, name) {

    var messageData = {
      recipient: {
        id: senderID
      },
      message: {
        text: "Olá " + name + ", seja bem vindo ao bot do APIX 2017. O que deseja comprar?",
        metadata: "WELCOME_MESSAGE"
      }
    };

    callSendAPI(messageData);
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