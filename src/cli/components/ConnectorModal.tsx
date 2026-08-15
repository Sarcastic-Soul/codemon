import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  loadUserConfig,
  setApiKey,
  removeApiKey,
  maskApiKey,
  getEffectiveApiKey,
  setDefaultModel,
} from "../../config/user-config.ts";
import { fetchLiveModels, CURATED_MODELS } from "../../providers/model-fetcher.ts";

export interface ConnectorResult {
  provider: string;
  model: string;
  apiKey?: string;
}

interface ConnectorModalProps {
  onClose: () => void;
  onSelectProviderModel: (result: ConnectorResult) => void;
}

const PROVIDERS = [
  {
    id: "google",
    name: "Google Gemini",
    models: CURATED_MODELS.google!,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    models: CURATED_MODELS.anthropic!,
  },
  {
    id: "openai",
    name: "OpenAI GPT",
    models: CURATED_MODELS.openai!,
  },
  {
    id: "mistral",
    name: "Mistral AI",
    models: CURATED_MODELS.mistral!,
  },
];

type Step = "select-provider" | "enter-key" | "select-model" | "custom-model";

export function ConnectorModal({ onClose, onSelectProviderModel }: ConnectorModalProps) {
  const [step, setStep] = useState<Step>("select-provider");
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [customModelInput, setCustomModelInput] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const selectedProvider = PROVIDERS[providerIndex] ?? PROVIDERS[0]!;

  // Fetch live models when entering model selection step
  useEffect(() => {
    if (step !== "select-model") return;

    let isMounted = true;
    const key = getEffectiveApiKey(selectedProvider.id);
    setIsLoadingModels(true);

    fetchLiveModels(selectedProvider.id, key)
      .then((models) => {
        if (!isMounted) return;
        setAvailableModels(models.length > 0 ? models : selectedProvider.models);
        setIsLoadingModels(false);
      })
      .catch(() => {
        if (!isMounted) return;
        setAvailableModels(selectedProvider.models);
        setIsLoadingModels(false);
      });

    return () => {
      isMounted = false;
    };
  }, [step, selectedProvider.id]);

  const activeModelsList = availableModels.length > 0 ? availableModels : selectedProvider.models;

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (step === "select-provider") {
      if (key.upArrow) {
        setProviderIndex((prev) => (prev > 0 ? prev - 1 : PROVIDERS.length - 1));
      } else if (key.downArrow) {
        setProviderIndex((prev) => (prev < PROVIDERS.length - 1 ? prev + 1 : 0));
      } else if (input === "r" || input === "R") {
        removeApiKey(selectedProvider.id);
        setStatusMessage(`Cleared API key for ${selectedProvider.name}`);
      } else if (key.return) {
        const existingKey = getEffectiveApiKey(selectedProvider.id) || "";
        setApiKeyInput(existingKey);
        setStep("enter-key");
      }
    } else if (step === "select-model") {
      const modelOptions = [...activeModelsList, "Custom model name..."];
      if (key.upArrow) {
        setModelIndex((prev) => (prev > 0 ? prev - 1 : modelOptions.length - 1));
      } else if (key.downArrow) {
        setModelIndex((prev) => (prev < modelOptions.length - 1 ? prev + 1 : 0));
      } else if (key.return) {
        if (modelIndex === activeModelsList.length) {
          setStep("custom-model");
        } else {
          const chosenModel = activeModelsList[modelIndex]!;
          const fullModelString = `${selectedProvider.id}:${chosenModel}`;
          setDefaultModel(fullModelString);
          onSelectProviderModel({
            provider: selectedProvider.id,
            model: fullModelString,
            apiKey: getEffectiveApiKey(selectedProvider.id),
          });
        }
      }
    }
  });

  const handleApiKeySubmit = () => {
    if (apiKeyInput.trim()) {
      setApiKey(selectedProvider.id, apiKeyInput.trim());
      setStatusMessage(`Saved API key for ${selectedProvider.name} (0600 file mode)`);
    }
    setModelIndex(0);
    setStep("select-model");
  };

  const handleCustomModelSubmit = () => {
    if (!customModelInput.trim()) return;
    const fullModelString = customModelInput.includes(":")
      ? customModelInput.trim()
      : `${selectedProvider.id}:${customModelInput.trim()}`;
    setDefaultModel(fullModelString);
    onSelectProviderModel({
      provider: selectedProvider.id,
      model: fullModelString,
      apiKey: getEffectiveApiKey(selectedProvider.id),
    });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🔌 CODEMON PROVIDER & MODEL CONNECTOR
        </Text>
      </Box>

      {statusMessage ? (
        <Box marginBottom={1}>
          <Text color="green">✓ {statusMessage}</Text>
        </Box>
      ) : null}

      {step === "select-provider" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              Select LLM Provider (Use ↑/↓, Enter to select, 'r' to remove key, Esc to cancel):
            </Text>
          </Box>
          {PROVIDERS.map((p, idx) => {
            const isSelected = idx === providerIndex;
            const key = getEffectiveApiKey(p.id);
            const keyText = key ? `[Key: ${maskApiKey(key)}]` : "[Not Set]";
            return (
              <Box key={p.id} paddingLeft={1}>
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "> " : "  "}
                  {p.name}
                </Text>
                <Text color={key ? "green" : "yellow"}> {keyText}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "enter-key" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              Enter / Paste API Key for {selectedProvider.name}:
            </Text>
          </Box>

          <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={handleApiKeySubmit}
              placeholder="Paste key here or press Enter to skip..."
              mask="*"
            />
          </Box>
          <Text dimColor>Stored in ~/.codemon/config.json with 0600 mode permissions.</Text>
          <Text dimColor>Press Enter to confirm key and proceed to model selection.</Text>
        </Box>
      )}

      {step === "select-model" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              Select Model for {selectedProvider.name}{" "}
              {isLoadingModels ? "(fetching live models...)" : "(live models fetched)"}:
            </Text>
          </Box>
          {[...activeModelsList, "Custom model name..."].map((m, idx) => {
            const isSelected = idx === modelIndex;
            return (
              <Box key={m} paddingLeft={1}>
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "> " : "  "}
                  {m}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "custom-model" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>
              Enter Custom Model Identifier (e.g. {selectedProvider.id}:custom-model-id):
            </Text>
          </Box>

          <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
            <TextInput
              value={customModelInput}
              onChange={setCustomModelInput}
              onSubmit={handleCustomModelSubmit}
              placeholder={`${selectedProvider.id}:my-custom-model`}
            />
          </Box>
          <Text dimColor>Press Enter to set custom model.</Text>
        </Box>
      )}
    </Box>
  );
}
