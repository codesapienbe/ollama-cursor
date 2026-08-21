// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { ActivityReporter } from '../activity';
import { AgentEditService } from '../agentEditService';
import { OllamaClient } from '../client';
import { CodeIndexStore } from '../codeIndex';
import { ConversationStore } from '../conversationStore';
import { MultiAgentService } from '../multiAgentService';
import { PlanService } from '../planService';
import { Settings } from '../settings';
import { TokenStore } from '../tokenStore';
import { SharedChatViewProvider } from './sharedChatView';

export class ChatWidgetProvider extends SharedChatViewProvider {
  public static readonly viewType = 'olliberty.chatView';

  constructor(
    extensionUri: vscode.Uri,
    client: OllamaClient,
    settings: Settings,
    codeIndex: CodeIndexStore,
    editService: AgentEditService,
    multiAgentService: MultiAgentService,
    conversationStore: ConversationStore,
    tokenStore: TokenStore,
    activity: ActivityReporter,
    planService: PlanService
  ) {
    super(
      extensionUri,
      client,
      settings,
      codeIndex,
      editService,
      multiAgentService,
      conversationStore,
      tokenStore,
      activity,
      planService
    );
  }
}
