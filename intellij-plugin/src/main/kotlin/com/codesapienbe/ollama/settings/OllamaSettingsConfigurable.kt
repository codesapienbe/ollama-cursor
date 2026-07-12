package com.codesapienbe.ollama.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/** "Settings > Tools > Ollama Assistant" page. */
class OllamaSettingsConfigurable : Configurable {

    private val state = OllamaSettingsState.getInstance()

    private val modelField = JBTextField()
    private val temperatureField = JBTextField()
    private val maxTokensField = JBTextField()
    private val contextLengthField = JBTextField()

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Ollama Assistant"

    override fun createComponent(): JComponent {
        val built = FormBuilder.createFormBuilder()
            .addLabeledComponent("Model:", modelField)
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
        return modelField.text != state.model ||
            temperatureField.text.toDoubleOrNull() != state.temperature ||
            maxTokensField.text.toIntOrNull() != state.maxTokens ||
            contextLengthField.text.toIntOrNull() != state.contextLength
    }

    override fun apply() {
        state.model = modelField.text.trim().ifEmpty { "codellama" }
        temperatureField.text.toDoubleOrNull()?.let { state.temperature = it }
        maxTokensField.text.toIntOrNull()?.let { state.maxTokens = it }
        contextLengthField.text.toIntOrNull()?.let { state.contextLength = it }
    }

    override fun reset() {
        modelField.text = state.model
        temperatureField.text = state.temperature.toString()
        maxTokensField.text = state.maxTokens.toString()
        contextLengthField.text = state.contextLength.toString()
    }
}
