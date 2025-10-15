const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);
const io = new Server(server);
var companieData  = {};
var hackerSockets = [];

/*********** CONFIG ***********/
const timeLeftStartDate = new Date("2025-10-31 14:00");
const timeLeftTotalTime = 4 * 60 * 60;
const validChatIds      = ["dS5kiwjV2VMSi2jJlxPewYC4U",
			   "qXDY7Sz1d1XGc4BRpGeymuGWZ",
			   "dOsW8EPTqpcsmmq4KBcqeE3cS",
			   "P048tdEMCBuwb17KBY66UxmV2",
			   "JB0okKxSoifhL16hr0XW6wBfE",
			   "QxBqArvo2BF5zFo5Gd2RwIL5I",
			   "PkMPKEbYzM0F6kFAIImVfXLgB",
			   "LrvF8yLqqWhPShi0ap8dKgRsc",
			   "puIjJM5XkZrRk9J28x5U60xq0",
			   "vJBTtf6HlHh36GsWRSy1RMjEA",
			   "a6edzXzjsUfwM3mMbIFHKH7Af",
			   "jjCC6XbfY7ylgWVmfIUHuVoxj",
			   "kjsdlHkbU8DhoFmQRXuYvLgGu",
			   "9t7pkyGlWV9Z6Hi0gZcZCrJBw",
			   "LcdM2htAXqAEE8rCaUbSLpJKa",
			  ];

app.use(express.static('www'))

function getTimeStamp() {
    const d = new Date();
    return d.getUTCDate() + "-" + d.getUTCMonth() + "-" + d.getUTCFullYear() + " " + d.getUTCHours() + ":" + d.getUTCMinutes() + ":" + d.getUTCSeconds();
}

function escape(htmlStr) {
    return htmlStr.replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");         
}

function isHackerSocket(socket) {
    for ( var i=0; i < hackerSockets.length; i++ ) {
	if ( socket.id == hackerSockets[i].id ) {
	    return true;
	}
    }
    
    return false;
}

function hackerSocketEmit(topic, data) {
    for ( var i=0; i < hackerSockets.length; i++ ) {
	hackerSockets[i].emit(topic, data);
    }
}

io.on('connection', (socket) => {
    console.log('a user connected');
    socket._data = {valid: false, company: "", chatid: "", chat: []}; // user data

    socket.on('disconnect', () => {
        console.log('user disconnected');
	hackerSockets.forEach( function(v) {
	    if ( socket.id == v.id ) {
		console.log("hacker left the building");
		hackerSockets.splice( hackerSockets.indexOf(v), 1); // Remove socket from the array
	    }
	});
    });

    socket.on('chat-message-darknet', (data) => { // {chatid, msg}
        data.msg = escape(data.msg);

	console.log("*******************");
	console.log(data.chatid in companieData);
	console.log(isHackerSocket(socket));
	console.log("*******************");
        if ( data.chatid in companieData && isHackerSocket(socket) ) { // the hacker            
            let chatMessage = {timestamp: getTimeStamp(), who: "darknet", chat: data.msg};
            console.log("send darknet");
            console.log("'"  + data.chatid + "'");
            console.log(chatMessage);
            io.to(data.chatid).emit("chat-message-darknet", chatMessage);
            companieData[data.chatid].chat.push(chatMessage);
            //if ( hackerSocket != null ) {
            //    hackerSocket.emit("update-chat", companieData[data.chatid]);
            //}
	    hackerSocketEmit("update-chat", companieData[data.chatid]);
            console.log("send darknet");

        } else if ( socket._data.valid ) { // the company
            let chatMessage = {timestamp: getTimeStamp(), who: "darknet", chat: data.msg};
            socket._data.chat.push(chatMessage);
            io.to(data.chatid).emit("chat-message-darknet", chatMessage);
            companieData[socket._data.chatid] = socket._data;
            //console.log(socket._data);

        } else {
            console.log("problem with socket");
        }
    });

    socket.on('chat-message-company', (msg) => {
        msg = escape(msg);
        console.log("MSG: "  + JSON.stringify(msg));
        if ( socket._data.valid ) {
            let chatMessage = {timestamp: getTimeStamp(), who: "company", chat: msg};
            socket._data.chat.push(chatMessage);
            io.to(socket._data.chatid).emit("chat-message-company", chatMessage);
            companieData[socket._data.chatid] = socket._data;
            //if ( hackerSocket != null ) {
            //    hackerSocket.emit("update-chat", socket._data);
            //}
	    hackerSocketEmit("update-chat", socket._data);
            //console.log(JSON.stringify(companieData));
            //console.log(socket._data);
        } else {
            console.log("problem with socket");
        }
    });
    
    socket.on('hacker-login', (data) => {
        if ( data.username == "darknet" && data.password == "darknet" ) {
            console.log("hacker entered the building");
	    if ( hackerSockets.indexOf(socket) == -1 ) {
		hackerSockets.push(socket);
	    }
            socket.emit("get-company-data", companieData);
            socket.emit("timeleft", {timestamp: timeLeftStartDate.getTime()/1000, total: timeLeftTotalTime});
        }
    });

    socket.on('delete-chat', (chatid) => {
        if ( chatid in companieData ) {
            delete companieData[chatid];
        }
        socket.emit("get-company-data", companieData);
    });

    socket.on('chat-login', (msg) => {
        let pattern = /^[a-zA-Z0-9_\. ]+$/;
        if ( pattern.test(msg.chatid) && pattern.test(msg.company) ) {
	    if ( validChatIds.indexOf(msg.chatid) > -1 ) { // Check for valid chatID
		if ( socket._data.valid == false ) {
                    if ( msg.chatid in companieData ) { // Restore the data!
			console.log("bestaat al!");
			socket.join(msg.chatid); // Join chatid room!
			socket._data = companieData[msg.chatid]; // load previous data
			for (let i=0; i < socket._data.chat.length; i++) {
                            console.log(socket._data.chat[i]);
                            if ( socket._data.chat[i].who == "darknet" ) {
				io.to(socket._data.chatid).emit("chat-message-darknet", socket._data.chat[i]);
                            } else {
				io.to(socket._data.chatid).emit("chat-message-company", socket._data.chat[i]);
                            }
			}
			io.to(socket._data.chatid).emit("timeleft", {timestamp: timeLeftStartDate.getTime()/1000, total: timeLeftTotalTime});
			//if ( hackerSocket != null ) {
                        //    hackerSocket.emit("update-chat", socket._data);
			//}
			hackerSocketEmit("update-chat", socket._data);
			
                    } else {
			socket._data.chatid = msg.chatid;
			socket._data.company = msg.company;
			socket._data.valid = true;
			socket.join(msg.chatid); // Join chatid room!
			var chatMessage = {
                            timestamp: getTimeStamp(), who: "darknet",
                            chat: "Welcome '" + msg.company + "' to our chat with chat id '" + msg.chatid + "'. Chat started at (UTC) " + getTimeStamp() + ". Paying is the fastest way out!"
			};
			socket._data.chat.push(chatMessage);
			io.to(socket._data.chatid).emit("chat-message-darknet", chatMessage);
			io.to(socket._data.chatid).emit("timeleft", {timestamp: timeLeftStartDate.getTime()/1000, total: timeLeftTotalTime});
			companieData[socket._data.chatid] = socket._data;
			console.log(socket._data);
			//if ( hackerSocket != null ) {
                        //    hackerSocket.emit("update-chat", socket._data);
			//}
			hackerSocketEmit("update-chat", socket._data);
                    }
		} else {
                    console.log("socket tries to hack!");
		}
	    } else {
		console.log("chatid is not valid");
	    }
	} else {
	    console.log("chatid or company not correct!");
        }
    });
  });

server.listen(3000, () => {
  console.log('server running at http://localhost:3000');
});

function setTime() {

}
