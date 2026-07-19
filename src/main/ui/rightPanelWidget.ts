import * as vscode from 'vscode';
import { AgentEditService } from '../agentEditService';
import { OllamaClient } from '../client';
import { CodeIndexStore } from '../codeIndex';
import { ConversationStore } from '../conversationStore';
import { MultiAgentService } from '../multiAgentService';
import { Settings } from '../settings';
import { TokenStore } from '../tokenStore';
import { SharedChatViewProvider } from './sharedChatView';

export class RightPanelWidgetProvider extends SharedChatViewProvider {
  public static readonly viewType = 'olliberty.rightPanelView';

  constructor(
    extensionUri: vscode.Uri,
    client: OllamaClient,
    settings: Settings,
    codeIndex: CodeIndexStore,
    editService: AgentEditService,
    multiAgentService: MultiAgentService,
    conversationStore: ConversationStore,
    tokenStore: TokenStore
  ) {
    super(extensionUri, client, settings, codeIndex, editService, multiAgentService, conversationStore, tokenStore);
  }
}
