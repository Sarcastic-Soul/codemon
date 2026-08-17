import { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  setApiKey,
  removeApiKey,
  maskApiKey,
  getEffectiveApiKey,
  setDefaultModel,
} from "../../config/user-config.ts";
import { maybeRefreshCatalog } from "../../providers/catalog.ts";
import { listAvailableProviders, resolveModel } from "../../providers/resolve.ts";
import { fetchLiveModels } from "../../providers/model-fetcher.ts";

export interface ConnectorResult {
  provider: string;
  model: string;
  apiKey?: string;
}

interface ConnectorModalProps {
  onClose: () => void;
  onSelectProviderModel: (result: ConnectorResult) => void;
}

type Step = "select-provider" | "enter-key" | "select-model" | "custom-model";

const CUSTOM_MODEL_OPTION = "Custom model name…";

/** How many rows of a list are on screen at once. */
const WINDOW = 8;

/** Slide a fixed-size window over a long list so the cursor stays visible. */
function windowed<T>(items: T[], index: number): { slice: T[]; offset: number } {
  if (items.length <= WINDOW) return { slice: items, offset: 0 };
  const offset = Math.min(Math.max(index - Math.floor(WINDOW / 2), 0), items.length - WINDOW);
  return { slice: items.slice(offset, offset + WINDOW), offset };
}

function formatContext(tokens: number | undefined): string {
  if (!tokens) return "";
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`
    : `${Math.round(tokens / 1000)}k ctx`;
}

export function ConnectorModal({ onClose, onSelectProviderModel }: ConnectorModalProps) {
  const [step, setStep] = useState<Step>("select-provider");
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [customModelInput, setCustomModelInput] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);

  // A background refresh that lands while the modal is open should show up in
  // the list rather than wait for the next launch.
  useEffect(() => {
    let mounted = true;
    maybeRefreshCatalog().then((result) => {
      if (mounted && result === "updated") setCatalogVersion((v) => v + 1);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Providers with a key already set float to the top — with ~186 catalogued,
  // the ones you have actually configured are what you are almost always after.
  const providers = useMemo(() => {
    const all = listAvailableProviders().map((p) => ({
      id: p.id,
      name: p.name,
      hasKey: Boolean(getEffectiveApiKey(p.id)),
    }));
    return all.sort((a, b) => Number(b.hasKey) - Number(a.hasKey) || a.name.localeCompare(b.name));
  }, [catalogVersion, statusMessage]);

  const filteredProviders = useMemo(() => {
    const q = providerFilter.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => p.id.includes(q) || p.name.toLowerCase().includes(q));
  }, [providers, providerFilter]);

  const selectedProvider = filteredProviders[Math.min(providerIndex, filteredProviders.length - 1)];

  useEffect(() => {
    if (step !== "select-model" || !selectedProvider) return;

    let mounted = true;
    setIsLoadingModels(true);

    fetchLiveModels(selectedProvider.id, getEffectiveApiKey(selectedProvider.id))
      .then((models) => {
        if (!mounted) return;
        setAvailableModels(models);
        setIsLoadingModels(false);
      })
      .catch(() => {
        if (!mounted) return;
        setAvailableModels([]);
        setIsLoadingModels(false);
      });

    return () => {
      mounted = false;
    };
  }, [step, selectedProvider?.id]);

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    const base = q ? availableModels.filter((m) => m.toLowerCase().includes(q)) : availableModels;
    return [...base, CUSTOM_MODEL_OPTION];
  }, [availableModels, modelFilter]);

  const chooseModel = (modelId: string) => {
    if (!selectedProvider) return;
    const fullModelString = `${selectedProvider.id}:${modelId}`;
    setDefaultModel(fullModelString);
    onSelectProviderModel({
      provider: selectedProvider.id,
      model: fullModelString,
      apiKey: getEffectiveApiKey(selectedProvider.id),
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      // Step back through the flow rather than dropping the whole modal, so a
      // mistyped filter does not cost you the provider you already picked.
      if (step === "select-model" || step === "enter-key") {
        setStep("select-provider");
        setStatusMessage("");
        return;
      }
      if (step === "custom-model") {
        setStep("select-model");
        return;
      }
      onClose();
      return;
    }

    if (step === "select-provider") {
      if (key.upArrow) {
        setProviderIndex((prev) => (prev > 0 ? prev - 1 : filteredProviders.length - 1));
      } else if (key.downArrow) {
        setProviderIndex((prev) => (prev < filteredProviders.length - 1 ? prev + 1 : 0));
      } else if (key.ctrl && (input === "r" || input === "R")) {
        // ctrl-R, not plain 'r' — plain letters go to the filter box.
        if (selectedProvider) {
          removeApiKey(selectedProvider.id);
          setStatusMessage(`Cleared API key for ${selectedProvider.name}`);
        }
      } else if (key.return && selectedProvider) {
        setApiKeyInput(getEffectiveApiKey(selectedProvider.id) ?? "");
        setStep("enter-key");
      }
      return;
    }

    if (step === "select-model") {
      if (key.upArrow) {
        setModelIndex((prev) => (prev > 0 ? prev - 1 : filteredModels.length - 1));
      } else if (key.downArrow) {
        setModelIndex((prev) => (prev < filteredModels.length - 1 ? prev + 1 : 0));
      } else if (key.return) {
        const chosen = filteredModels[Math.min(modelIndex, filteredModels.length - 1)];
        if (!chosen || chosen === CUSTOM_MODEL_OPTION) setStep("custom-model");
        else chooseModel(chosen);
      }
    }
  });

  const handleApiKeySubmit = () => {
    if (!selectedProvider) return;
    if (apiKeyInput.trim()) {
      setApiKey(selectedProvider.id, apiKeyInput.trim());
      setStatusMessage(`Saved API key for ${selectedProvider.name} (0600 file mode)`);
    }
    setModelIndex(0);
    setModelFilter("");
    setStep("select-model");
  };

  const handleCustomModelSubmit = () => {
    const value = customModelInput.trim();
    if (!value) return;
    if (value.includes(":") && !selectedProvider) return;
    setDefaultModel(value.includes(":") ? value : `${selectedProvider?.id}:${value}`);
    onSelectProviderModel({
      provider: selectedProvider?.id ?? "",
      model: value.includes(":") ? value : `${selectedProvider?.id}:${value}`,
      apiKey: selectedProvider ? getEffectiveApiKey(selectedProvider.id) : undefined,
    });
  };

  const providerView = windowed(filteredProviders, providerIndex);
  const modelView = windowed(filteredModels, modelIndex);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          CODEMON PROVIDER & MODEL CONNECTOR
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
            <Text bold>Select provider </Text>
            <Text dimColor>
              (↑/↓ move · Enter select · ctrl-R clear key · Esc cancel · type to filter)
            </Text>
          </Box>

          <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
            <Text dimColor></Text>
            <TextInput
              value={providerFilter}
              onChange={(value) => {
                setProviderFilter(value);
                setProviderIndex(0);
              }}
              placeholder="filter 186 providers…"
            />
          </Box>

          {filteredProviders.length === 0 ? (
            <Text color="yellow"> No provider matches “{providerFilter}”.</Text>
          ) : (
            providerView.slice.map((p, idx) => {
              const isSelected = providerView.offset + idx === providerIndex;
              const key = getEffectiveApiKey(p.id);
              return (
                <Box key={p.id} paddingLeft={1}>
                  <Text color={isSelected ? "cyan" : "gray"}>
                    {isSelected ? "> " : "  "}
                    {p.name}
                  </Text>
                  <Text color={key ? "green" : "yellow"}>
                    {" "}
                    {key ? `[Key: ${maskApiKey(key)}]` : "[Not Set]"}
                  </Text>
                </Box>
              );
            })
          )}

          {filteredProviders.length > WINDOW && (
            <Box marginTop={1}>
              <Text dimColor>
                {providerIndex + 1}/{filteredProviders.length}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {step === "enter-key" && selectedProvider && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Enter / Paste API Key for {selectedProvider.name}:</Text>
          </Box>

          <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={handleApiKeySubmit}
              placeholder="Paste key here or press Enter to skip…"
              mask="*"
            />
          </Box>
          <Text dimColor>Stored in ~/.codemon/config.json with 0600 mode permissions.</Text>
          <Text dimColor>Press Enter to confirm and pick a model, Esc to go back.</Text>
        </Box>
      )}

      {step === "select-model" && selectedProvider && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Select model for {selectedProvider.name} </Text>
            <Text dimColor>{isLoadingModels ? "(fetching…)" : `(${availableModels.length})`}</Text>
          </Box>

          <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
            <Text dimColor></Text>
            <TextInput
              value={modelFilter}
              onChange={(value) => {
                setModelFilter(value);
                setModelIndex(0);
              }}
              placeholder="filter models…"
            />
          </Box>

          {modelView.slice.map((m, idx) => {
            const isSelected = modelView.offset + idx === modelIndex;
            const meta = m === CUSTOM_MODEL_OPTION ? undefined : resolveModel(selectedProvider.id, m);
            const context = formatContext(meta?.limit?.context);
            // A model that cannot call tools cannot drive the agent loop at all.
            const noTools = meta?.tool_call === false;

            return (
              <Box key={m} paddingLeft={1}>
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "> " : "  "}
                  {m}
                </Text>
                {context ? <Text dimColor> {context}</Text> : null}
                {noTools ? <Text color="yellow"> no tool use</Text> : null}
              </Box>
            );
          })}

          {filteredModels.length > WINDOW && (
            <Box marginTop={1}>
              <Text dimColor>
                {modelIndex + 1}/{filteredModels.length}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {step === "custom-model" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Enter model id (or a full {selectedProvider?.id ?? "provider"}:model string):</Text>
          </Box>

          <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
            <TextInput
              value={customModelInput}
              onChange={setCustomModelInput}
              onSubmit={handleCustomModelSubmit}
              placeholder={`${selectedProvider?.id ?? "provider"}:my-custom-model`}
            />
          </Box>
          <Text dimColor>Press Enter to set, Esc to go back.</Text>
        </Box>
      )}
    </Box>
  );
}
