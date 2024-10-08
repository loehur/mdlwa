const fs = require("fs-extra");
const webhook = require("./config.js");

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeInMemoryStore,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const auth_dir = "auth_mdl";
const log = (pino = require("pino"));
const { session } = { session: auth_dir };
const { Boom } = require("@hapi/boom");
const http = require("http");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = require("express")();
app.use(
  fileUpload({
    createParentPath: true,
  })
);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const server = require("http").createServer(app);
const port = 8033;
const qrcode = require("qrcode");

app.use("/assets", express.static(__dirname + "/client/assets"));
app.get("/", (req, res) => {
  res.sendFile("./client/index.html", {
    root: __dirname,
  });
});

const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }),
});

let sock;
let qr;
let qr_status;
let logged_in;

function clear_auth() {
  fs.emptyDirSync(auth_dir);
  fs.rmdirSync(auth_dir);
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(auth_dir);
  let { version, isLatest } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    auth: state,
    logger: log({ level: "silent" }),
    version,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });
  store.bind(sock.ev);
  sock.multi = true;
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      logged_in = false;
      let reason = new Boom(lastDisconnect.error).output.statusCode;
      if (reason === DisconnectReason.badSession) {
        console.log(
          `Bad Session File, Please Delete ${session} and Scan Again`
        );
        clear_auth();
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("Connection closed, reconnecting....");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("Connection Lost from Server, reconnecting...");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "Connection Replaced, Another New Session Opened, Please Close Current Session First"
        );
        clear_auth();
        connectToWhatsApp();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(`Device ${session} Logged Out, Please Scan Again.`);
        clear_auth();
        connectToWhatsApp();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("Restart Required, Restarting...");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("Connection TimedOut, Reconnecting...");
        connectToWhatsApp();
      } else {
        sock.end(`Unknown DisconnectReason: ${reason}|${lastDisconnect.error}`);
      }
    } else if (connection === "open") {
      logged_in = true;
      console.log("Connection Ready!");
      return;
    }

    if (update.qr) {
      qr = update.qr;
      qr_status = true;
    } else if ((qr = undefined)) {
      logged_in = false;
      qr_status = false;
    }
  });

  sock.ev.process(async (events) => {
    if (events["creds.update"]) {
      await saveCreds();
    }

    if (events["messages.update"]) {
      const resUp = events["messages.update"];
      console.log(JSON.stringify(resUp[0]));

      if (resUp[0].key.fromMe == true && resUp[0].update != {}) {
        fetch(webhook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resUp[0]),
        });
      }
    }
  });
}

const isConnected = () => {
  return sock.user;
};

var WebSocketServer = require("websocket").server;
wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});

function originIsAllowed(origin) {
  return true;
}

wsServer.on("request", function (request) {
  if (!originIsAllowed(request.origin)) {
    request.reject();
    console.log(
      new Date() + " Connection from origin " + request.origin + " rejected."
    );
    return;
  }

  var connection = request.accept("echo-protocol", request.origin);
  connection.on("message", function (message) {
    if (message.type === "utf8") {
      data = {};
      if (logged_in) {
        data = {
          status: logged_in,
        };
        connection.sendUTF(JSON.stringify(data));
      } else {
        if (qr_status) {
          qrcode.toDataURL(qr, (err, url) => {
            data = {
              status: logged_in,
              qr_ready: qr_status,
              qr_string: url,
            };
            connection.sendUTF(JSON.stringify(data));
          });
        } else {
          data = {
            status: logged_in,
            qr_ready: false,
          };
          connection.sendUTF(JSON.stringify(data));
        }
      }
    } else if (message.type === "binary") {
    }
  });
});

app.post("/send-message", async (req, res) => {
  const pesankirim = req.body.message;
  const number = req.body.number;

  let numberWA;
  try {
    if (!number) {
      res.status(500).json({
        status: false,
        response: "Whatsapp Number is Empty",
      });
    } else {
      numberWA = "62" + number.substring(1) + "@s.whatsapp.net";
      if (isConnected) {
        sock
          .sendMessage(numberWA, { text: pesankirim })
          .then((result) => {
            res.status(200).json({
              status: true,
              response: result,
            });
          })
          .catch((err) => {
            res.status(500).json({
              status: false,
              response: err,
            });
          });
      } else {
        res.status(500).json({
          status: false,
          response: `Whatsapp disconnected`,
        });
      }
    }
  } catch (err) {
    res.status(500).send(err);
  }
});

connectToWhatsApp().catch((err) => console.log("unexpected error: " + err)); // catch any errors
server.listen(port, () => {
  console.log("Server Port: " + port);
});
