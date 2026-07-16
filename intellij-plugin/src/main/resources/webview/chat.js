(function () {
  var messages = [];
  var isConnected = false;

  var messagesContainer = document.getElementById('messages-container');
  var messageInput = document.getElementById('message-input');
  var sendButton = document.getElementById('send-button');
  var connectionStatus = document.getElementById('connection-status');
  var installButtonContainer = document.getElementById('install-button-container');
  var installButton = document.getElementById('install-button');
  var clearButton = document.getElementById('clear-button');

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function dispatch(type, payload) {
    var message = JSON.stringify(Object.assign({ type: type }, payload || {}));
    /*__DISPATCH_INJECT__*/
  }

  function updateConnectionStatus() {
    if (!isConnected) {
      connectionStatus.innerHTML = '<div class="connection-error">⚠️ Ollama not connected</div>';
      installButtonContainer.style.display = 'flex';
      messageInput.disabled = true;
      sendButton.disabled = true;
      messageInput.placeholder = 'Install Ollama to continue...';
    } else {
      connectionStatus.innerHTML = '<div class="connection-success">✅ Ollama connected</div>';
      installButtonContainer.style.display = 'none';
      messageInput.disabled = false;
      sendButton.disabled = false;
      messageInput.placeholder = 'Ask Ollama...';
    }
  }

  function renderMessages() {
    messagesContainer.innerHTML = '';

    if (messages.length === 0) {
      messagesContainer.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-icon">🤖</div>' +
        '<div class="empty-state-title">Olliberty</div>' +
        '<div class="empty-state-description">Ask me anything about your code! ' +
        "I'll help you with explanations, debugging, and suggestions.</div>" +
        '</div>';
      return;
    }

    messages.forEach(function (message) {
      var el = document.createElement('div');
      el.className = 'message ' + message.role;

      var content = escapeHtml(message.content);
      if (message.role === 'system') {
        content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      } else {
        content = content
          .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
      }

      var avatarIcon = message.role === 'assistant' ? '🤖' : message.role === 'user' ? '🧑' : 'ℹ️';
      var time = new Date(message.timestamp).toLocaleTimeString();

      el.innerHTML =
        '<div class="message-header">' +
        '<span class="avatar">' + avatarIcon + '</span>' +
        '<span class="role">' + message.role + '</span>' +
        '<span class="timestamp">' + time + '</span>' +
        '</div>' +
        '<div class="message-content">' + content + '</div>';

      messagesContainer.appendChild(el);
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function sendMessage() {
    var text = messageInput.value.trim();
    if (!text || !isConnected) return;
    dispatch('sendMessage', { message: text });
    messageInput.value = '';
    messageInput.style.height = 'auto';
  }

  sendButton.addEventListener('click', sendMessage);

  installButton.addEventListener('click', function () {
    dispatch('installOllama');
  });

  clearButton.addEventListener('click', function () {
    dispatch('clearChat');
  });

  messageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = this.scrollHeight + 'px';
  });

  window.__olliberty_receive = function (json) {
    var data = JSON.parse(json);
    if (data.type === 'updateMessages') {
      messages = data.messages;
      isConnected = data.isConnected;
      renderMessages();
      updateConnectionStatus();
    }
  };

  renderMessages();
  dispatch('checkConnection');
})();
