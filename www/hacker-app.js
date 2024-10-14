/* 
 * Main Application
 * Maurice Snoeren
 */

var version = "0.1 beta";

/* Socket.IO and Events */
const socket = io();
socket.on('connect',              function ()    { onWebsocketConnection();            } );
socket.on('connect_error',        function ()    { onWebsocketConnectionError();       } );
socket.on('disconnect',           function ()    { onWebsocketDisconnection();         } );
socket.on('get-company-data',     function(data) { onWebsocketCompanyData(data);       } );
socket.on('update-chat',          function(data) { onWebsocketUpdateChat(data);        } );
socket.on('chat-message-darknet', function(data) { onWebsocketMessageDarkNet(data);    } );
socket.on('chat-message-company', function(data) { onWebsocketMessageCompany(data);    } );
socket.on('timeleft',             function(data) { onWebsocketTimeLeft(data);          } );

/* Workspace environment */
var companyData     = {};
var selectedCompany = -1;
var timeleft        = 0;

function logout () {
  window.location.href = "hacker-login.html";
} 

/* Function is called when the user pressen ctr-s. Could get some saving functionality later. */
function onCtrlSave() {
  console.log("onCtrlSave: crt-s is pressed");
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value) {
      socket.emit('chat-message-darknet', {chatid: selectedCompany, msg: input.value});
      input.value = '';
    }
});

/* 
 * Web Socket
 */

function onWebsocketConnection () {
    username = getUrlVar("username");  
    password = getUrlVar("password");

    let pattern = /^[a-zA-Z0-9_ ]{4}[a-zA-Z0-9_ ]+$/;
    if ( !pattern.test(username) || !pattern.test(password) ) {
        alert("Something went wrong (#1)");
        logout();
    }

    socket.emit('hacker-login', {username: username, password: password});

    valid = true;
}

function onWebsocketConnectionError () {
    alert("Websocket connection error (#2)");
    logout();
}

// When the websocket has been disconnected, this function is called.
function onWebsocketDisconnection () {
    alert("Websocket disconnection (#3)");
    logout();
}

function onWebsocketCompanyData ( data ) {
    companyData = data;
    updateDisplay();
}

function onWebsocketUpdateChat ( data ) {
    companyData[data.chatid] = data;
    companyData[data.chatid].new = true;
    console.log(companyData[data.chatid]);
    updateDisplay();
}

function onWebsocketMessageDarkNet ( data ) {
    $('#messages').append("<div style=\"padding: 10px;\"><b><i><small>(" + data.timestamp + ")</small><br/> DarkNet Gamers:</i></b> " + data.chat + "</div>");
    document.documentElement.scrollTop = document.documentElement.scrollHeight; 
}

function onWebsocketMessageCompany ( data ) {
    console.log(data);
    $('#messages').append("<div style=\"padding: 10px; text-align: right;\"><b><i><small>(" + data.timestamp + ")</small><br/> " + data.company + ":</i></b> " + data.chat + "</div>");
    document.documentElement.scrollTop = document.documentElement.scrollHeight; 
}

function onWebsocketTimeLeft ( data ) {
    timeleft = data
    console.log("Got timeleft: " + timeleft);
    setInterval(displayTimeLeft, 1000);
}

function displayTimeLeft() {
    var delta = getTimeLeft(timeleft.timestamp);
    var timeLeftString = getTimeLeftString(timeleft.total - delta);
    $('#timeleft').html("Timeleft: "  + timeLeftString);
}

function getTimeStamp() {
    const d = new Date();
    return d.getUTCDate() + "-" + d.getUTCMonth() + "-" + d.getUTCFullYear() + " " + d.getUTCHours() + ":" + d.getUTCMinutes() + ":" + d.getUTCSeconds();
}

/* Helper Functions */

function getUrlVar(key){
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    return urlParams.get(key);
}

function parseJson ( json ) {
  try {
    return JSON.parse(json);
    
  } catch(e) {
    alert(json);
    alert(e);
  }

  return null;
}

function getTimeLeft (timestamp) {
    var currentTimestamp = new Date();
    return Math.abs(currentTimestamp.getTime()/1000 - timestamp);
}

function getTimeLeftString (delta) {
    var days = Math.floor(delta / 86400);
    console.log()
    delta -= Math.round(days * 86400);

    var hours = Math.floor(delta / 3600) % 24;
    delta -= Math.round(hours * 3600);

    var minutes = Math.round(Math.floor(delta / 60) % 60);
    delta -= minutes * 60;

    var seconds = Math.round(delta % 60);  // in theory the modulus is not required

    return days + "d " + hours + "h " + minutes + "m " + seconds + "s";
}

function deleteChat () {
    if ( selectedCompany != -1 ) {
        socket.emit('delete-chat', selectedCompany);
    }
    selectedCompany = -1;
    updateDisplay();
}

function updateDisplay () {
    var chats = Object.keys(companyData);
    $('#chatbar').html("");
    for (var i=0; i < chats.length; i++) {
        if ( selectedCompany == chats[i] ) {
            companyData[chats[i]].new = false;
            $('#chatbar').append("<a onclick=\"selectedCompany='" + chats[i] + "'; updateDisplay();\"><b style=\"background-color: #0F0; color: #000;\">" + chats[i] + "</b></a> | ");
        } else {
            if ( companyData[chats[i]].new ) {
                $('#chatbar').append("<a onclick=\"selectedCompany='" + chats[i] + "'; updateDisplay();\"><b style=\"background-color: #0FF; color: #000;\">(*)</b>" + chats[i] + "</a> | ");    
            } else {
                $('#chatbar').append("<a onclick=\"selectedCompany='" + chats[i] + "'; updateDisplay();\">" + chats[i] + "</a> | ");    
            }
        }
    }

    $('#messages').html(""); // empty
    if ( selectedCompany in companyData ) { // something is selected populate the stuff
        c = companyData[selectedCompany];
        for ( var i=0; i < c.chat.length; i++ ) {
            var chat = c.chat[i];
            chat.company = c.company;
            if ( chat.who == "darknet" ) {
                onWebsocketMessageDarkNet ( chat );
            } else {
                onWebsocketMessageCompany ( chat );
            }
        }    
    }
}