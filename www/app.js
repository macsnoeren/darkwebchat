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
socket.on('chat-message-darknet', function(data) { onWebsocketMessageDarkNet(data);    } );
socket.on('chat-message-company', function(data) { onWebsocketMessageCompany(data);    } );
socket.on('timeleft',             function(data) { onWebsocketTimeLeft(data);          } );

/* Workspace environment */
var company       = "";
var chatId        = "";
var valid         = false;
var timeleft      = 0;

function logout () {
  window.location.href = "index.html";
} 

/* Function is called when the user pressen ctr-s. Could get some saving functionality later. */
function onCtrlSave() {
  console.log("onCtrlSave: crt-s is pressed");
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value) {
      socket.emit('chat-message-company', input.value);
      input.value = '';
    }
});

/* 
 * Web Socket
 */

function onWebsocketConnection () {
    company = getUrlVar("company");  
    chatId  = getUrlVar("chatid");

    let pattern = /^[a-zA-Z0-9_ ]{4}[a-zA-Z0-9_ ]+$/;
    if ( !pattern.test(chatId) || !pattern.test(company) ) {
        alert("Something went wrong (#1)");
        logout();
    }

    socket.emit('chat-login', {chatid: chatId, company: company});

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

function onWebsocketMessageDarkNet ( data ) {
    $('#messages').append("<div style=\"padding: 10px;\"><b><i><small>(" + data.timestamp + ")</small><br/> DarkNet Gamers:</i></b> " + data.chat + "</div>");
    document.documentElement.scrollTop = document.documentElement.scrollHeight;
    console.log("onWebsocketMessageDarkNet");
    console.log(data);
}

function onWebsocketMessageCompany ( data ) {
    $('#messages').append("<div style=\"padding: 10px; text-align: right;\"><b><i><small>(" + data.timestamp + ")</small><br/> " + company + ":</i></b> " + data.chat + "</div>");
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