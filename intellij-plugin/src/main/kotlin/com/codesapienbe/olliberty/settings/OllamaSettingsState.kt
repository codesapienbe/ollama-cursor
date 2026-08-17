package com.codesapienbe.ollama.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

/** Single source of truth for user-configurable Ollama options, persisted across restarts. */
@Service
@State(name = "OllamaSettingsState", storages = [Storage("ollama-assistant.xml", roamingType = RoamingType.DISABLED)])
class OllamaSettingsState : PersistentStateComponent<OllamaSettingsState.State> {

    data class State(
        var url: String = "http://localhost:11434",
        var model: String = "gemma4:12b-it-qat",
        var effort: String = "medium",
        var systemPrompt: String = "",
        var temperature: Double = 0.2,
        var maxTokens: Int = 2048,
        var contextLength: Int = 4096,
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    var url: String
        get() = state.url
        set(value) { state.url = value.trim().trimEnd('/').ifEmpty { "http://localhost:11434" } }

    var model: String
        get() = state.model
        set(value) { state.model = value }

    var effort: String
        get() = state.effort
        set(value) {
            state.effort = when (value.trim().lowercase()) {
                "minimal", "low", "medium", "high", "max" -> value.trim().lowercase()
                else -> "medium"
            }
        }

    var systemPrompt: String
        get() = state.systemPrompt
        set(value) { state.systemPrompt = value }

    var temperature: Double
        get() = state.temperature
        set(value) { state.temperature = value.coerceIn(0.0, 1.0) }

    var maxTokens: Int
        get() = state.maxTokens
        set(value) { state.maxTokens = value.coerceIn(1, 8192) }

    var contextLength: Int
        get() = state.contextLength
        set(value) { state.contextLength = value.coerceIn(512, 8192) }

    val timeoutMs: Long get() = 45_000

    companion object {
        fun getInstance(): OllamaSettingsState = service()
    }
}
