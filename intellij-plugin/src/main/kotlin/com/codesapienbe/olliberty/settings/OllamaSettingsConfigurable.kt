package com.codesapienbe.olliberty.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/** "Settings > Tools > Olliberty" page. */
class OllamaSettingsConfigurable : Configurable {

    private val state = OllamaSettingsState.getInstance()

    private val urlField = JBTextField()
    private val modelField = JBTextField()
    private val effortField = JBTextField()
    private val systemPromptField = JBTextArea(4, 40).apply { lineWrap = true; wrapStyleWord = true }
    private val temperatureField = JBTextField()
    private val maxTokensField = JBTextField()
    private val contextLengthField = JBTextField()

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Olliberty"

    override fun createComponent(): JComponent {
        val built = FormBuilder.createFormBuilder()
            .addLabeledComponent("Ollama server URL:", urlField)
            .addLabeledComponent("Model:", modelField)
            .addLabeledComponent("Reasoning effort (minimal|low|medium|high|max):", effortField)
            .addLabeledComponent("System prompt:", JBScrollPane(systemPromptField))
            .addLabeledComponent("Temperature (0.0 - 1.0):", temperatureField)
            .addLabeledComponent("Max tokens:", maxTokensField)
            .addLabeledComponent("Context length:", contextLengthField)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = built
        reset()
        return built
    }

    override fun isModified(): Boolean {
        return urlField.text != state.url ||
            modelField.text != state.model ||
            effortField.text.lowercase() != state.effort ||
            systemPromptField.text != state.systemPrompt ||
            temperatureField.text.toDoubleOrNull() != state.temperature ||
            maxTokensField.text.toIntOrNull() != state.maxTokens ||
            contextLengthField.text.toIntOrNull() != state.contextLength
    }

    override fun apply() {
        state.url = urlField.text
        state.model = modelField.text.trim().ifEmpty { "gemma4:12b-it-qat" }
        state.effort = effortField.text
        state.systemPrompt = systemPromptField.text
        temperatureField.text.toDoubleOrNull()?.let { state.temperature = it }
        maxTokensField.text.toIntOrNull()?.let { state.maxTokens = it }
        contextLengthField.text.toIntOrNull()?.let { state.contextLength = it }
    }

    override fun reset() {
        urlField.text = state.url
        modelField.text = state.model
        effortField.text = state.effort
        systemPromptField.text = state.systemPrompt
        temperatureField.text = state.temperature.toString()
        maxTokensField.text = state.maxTokens.toString()
        contextLengthField.text = state.contextLength.toString()
    }
}
