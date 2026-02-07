import { world, system, CommandPermissionLevel, CustomCommandParamType } from '@minecraft/server';
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from '@minecraft/server-net';
import { ModalFormData, ActionFormData } from '@minecraft/server-ui';

// ===== BEDROCKMAP CONFIGURATION =====
// These values are injected when you download the addon
const BEDROCKMAP_API_KEY = '2f8afa7507c4f4199460cd743b3091078cde10624776d541471bcf002d8bbe09';
const BEDROCKMAP_WORLD_SLUG = 'the-tribe';
const API_BASE_URL = 'https://bedrockmap.net/api/premium';

// Update intervals
const PLAYER_TRACKING_INTERVAL = 100; // 5 seconds (100 ticks)
const ENABLE_LOGGING = true;
// ====================================

class BedrockMapAddon {
    constructor() {
        this.isPlayerTrackingRunning = false;
        this.playerTrackingIntervalId = null;
        this.lastPlayerCount = 0;
        this.isRequestPending = false;
        this.currentWorldSlug = BEDROCKMAP_WORLD_SLUG; // Updated from API responses
    }

    // Update slug from API response (in case user changed it)
    updateSlugFromResponse(responseSlug) {
        if (responseSlug && responseSlug !== this.currentWorldSlug) {
            this.log(`World slug updated: ${this.currentWorldSlug} -> ${responseSlug}`);
            this.currentWorldSlug = responseSlug;
        }
    }

    getMapUrl() {
        return `${this.currentWorldSlug}.bedrockmap.net`;
    }

    // ============================================
    // PLAYER TRACKING SYSTEM
    // ============================================

    startPlayerTracking() {
        if (this.isPlayerTrackingRunning) {
            return;
        }

        this.isPlayerTrackingRunning = true;
        this.log('Player tracking started');

        try {
            this.playerTrackingIntervalId = system.runInterval(() => {
                this.trackPlayers();
            }, PLAYER_TRACKING_INTERVAL);
        } catch (error) {
            this.log('ERROR setting up player tracking: ' + error.toString(), 'error');
            return;
        }

        try {
            world.sendMessage('§a[BedrockMap] Player tracking started - your position will appear on the map!');
        } catch (error) {
            this.log('ERROR sending notification: ' + error.toString(), 'error');
        }
    }

    stopPlayerTracking() {
        if (!this.isPlayerTrackingRunning) return;

        if (this.playerTrackingIntervalId !== null) {
            system.clearRun(this.playerTrackingIntervalId);
            this.playerTrackingIntervalId = null;
        }

        this.isPlayerTrackingRunning = false;
        this.log('Player tracking stopped');
        world.sendMessage('§c[BedrockMap] Player tracking stopped');
    }

    async trackPlayers() {
        if (this.isRequestPending) {
            this.log('Skipping update - previous request still pending', 'warn');
            return;
        }

        try {
            const players = world.getAllPlayers();

            if (players.length === 0) {
                if (this.lastPlayerCount > 0) {
                    this.log('No players online');
                    this.lastPlayerCount = 0;
                }
                return;
            }

            const playerData = players.map(player => {
                const location = player.location;
                return {
                    name: player.name,
                    uuid: player.id,
                    x: Math.round(location.x * 100) / 100,
                    y: Math.round(location.y * 100) / 100,
                    z: Math.round(location.z * 100) / 100,
                    dimension: player.dimension.id,
                    timestamp: Date.now()
                };
            });

            this.isRequestPending = true;
            await this.sendPlayerTracking(playerData);

            if (this.lastPlayerCount !== players.length) {
                this.log(`Player count: ${players.length}`);
                this.lastPlayerCount = players.length;
            }

        } catch (error) {
            this.log('Error tracking players: ' + error.toString(), 'error');
        } finally {
            this.isRequestPending = false;
        }
    }

    async sendPlayerTracking(playerData) {
        try {
            const request = new HttpRequest(`${API_BASE_URL}/player-tracking`);
            request.method = HttpRequestMethod.Post;
            request.headers = [
                new HttpHeader('Content-Type', 'application/json'),
                new HttpHeader('X-API-Key', BEDROCKMAP_API_KEY)
            ];

            const payload = {
                players: playerData,
                timestamp: Date.now()
            };

            request.body = JSON.stringify(payload);
            const response = await http.request(request);

            if (response.status >= 200 && response.status < 300) {
                // Success - silent
            } else {
                this.log(`Player tracking API returned status ${response.status}`, 'warn');
            }

        } catch (error) {
            this.log('Failed to send player tracking: ' + error.toString(), 'error');
        }
    }

    // ============================================
    // MARKER MANAGEMENT SYSTEM
    // ============================================

    showMarkerManagementMenu(player) {
        const form = new ActionFormData()
            .title("§6BedrockMap Markers")
            .body(`§7Manage markers on your world map at\n§b${this.getMapUrl()}\n\n§eChoose an action:`)
            .button("§a+ Add New Marker\n§8Create a marker at your location", "textures/ui/color_plus.png")
            .button("§c- Delete Marker\n§8Remove one of your markers", "textures/ui/cancel.png")
            .button("§8Close", "textures/ui/crossout.png");

        form.show(player).then((response) => {
            if (response.canceled) return;

            switch (response.selection) {
                case 0: // Add Marker
                    this.showAddMarkerForm(player);
                    break;
                case 1: // Delete Marker
                    this.showDeleteMarkerMenu(player);
                    break;
                case 2: // Close
                    return;
            }
        }).catch((error) => {
            player.sendMessage("§c[BedrockMap] Failed to show menu: " + error.message);
        });
    }

    showAddMarkerForm(player) {
        const form = new ModalFormData()
            .title("§6Add Map Marker")
            .textField("§7Add a marker to your BedrockMap!\n\n§eMarker Name: §7(100 Character Limit)", "Enter marker name...")
            .textField("§eMarker Description: §7(100 Character Limit)", "Enter a description...")
            .dropdown("§eMarker Type:", ["Home", "Shop", "Farm", "Landmark"])
            .submitButton("Add Marker");

        form.show(player).then((formData) => {
            if (formData.canceled) {
                return;
            }

            const title = formData.formValues[0];
            const description = formData.formValues[1];
            const markerTypeIndex = formData.formValues[2];
            const markerTypes = ["home", "shop", "farm", "landmark"];
            const markerType = markerTypes[markerTypeIndex];

            // Validate inputs
            if (!title || !description) {
                player.sendMessage("§c[BedrockMap] Both marker name and description are required.");
                return;
            }

            // Send marker to API
            this.submitMarkerToAPI(player, title, description, markerType);
        }).catch((error) => {
            player.sendMessage("§c[BedrockMap] Failed to show form: " + error.message);
        });
    }

    async submitMarkerToAPI(player, title, description, markerType) {
        try {
            const location = player.location;
            const dimension = player.dimension.id;

            const markerData = {
                x: Math.floor(location.x),
                z: Math.floor(location.z),
                text: title,
                description: description,
                type: markerType,
                dimension: dimension,
                playerName: player.name, // This populates the author field!
                font: 'Press Start 2P',
                fontSize: 14,
                colour: '#FFFFFF',
                backgroundColour: '#000000'
            };

            const request = new HttpRequest(`${API_BASE_URL}/markers`);
            request.method = HttpRequestMethod.Post;
            request.headers = [
                new HttpHeader('Content-Type', 'application/json'),
                new HttpHeader('X-API-Key', BEDROCKMAP_API_KEY)
            ];
            request.body = JSON.stringify(markerData);

            const response = await http.request(request);

            if (response.status === 200) {
                try {
                    const responseData = JSON.parse(response.body);
                    if (responseData.success) {
                        player.sendMessage("§a[BedrockMap] " + (responseData.message || "Marker added successfully!"));
                        this.updateSlugFromResponse(responseData.worldSlug);
                        player.sendMessage(`§7View it at: §b${this.getMapUrl()}`);
                    } else {
                        player.sendMessage("§c[BedrockMap] Failed to add marker: " + (responseData.error || "Unknown error"));
                    }
                } catch (parseError) {
                    player.sendMessage("§a[BedrockMap] Marker submitted successfully!");
                }
            } else if (response.status === 403) {
                // Permission denied
                try {
                    const errorData = JSON.parse(response.body);
                    player.sendMessage("§c[BedrockMap] " + errorData.error);
                } catch {
                    player.sendMessage("§c[BedrockMap] You don't have permission to add markers.");
                }
            } else {
                player.sendMessage("§c[BedrockMap] Server error: " + response.status);
            }
        } catch (error) {
            player.sendMessage("§c[BedrockMap] Error: " + error.message);
            this.log("Marker submission error:", error);
        }
    }

    async showDeleteMarkerMenu(player) {
        try {
            player.sendMessage("§e[BedrockMap] Loading your markers...");

            // Fetch markers for this player
            const markers = await this.fetchPlayerMarkers(player.name);

            if (!markers || markers.length === 0) {
                player.sendMessage("§e[BedrockMap] You don't have any markers to delete.");
                return;
            }

            // Build delete menu
            const form = new ActionFormData()
                .title("§cDelete Marker")
                .body(`§7You have §e${markers.length} marker${markers.length !== 1 ? 's' : ''}\n§7Select a marker to delete:`);

            // Add button for each marker
            markers.forEach(marker => {
                const typeIcon = this.getMarkerTypeIcon(marker.marker_type);
                const dimDisplay = marker.dimension.replace('minecraft:', '');
                form.button(
                    `${typeIcon} §f${marker.text}\n§8${dimDisplay} | ${marker.x}, ${marker.z}`,
                    "textures/ui/cancel.png"
                );
            });

            // Add back button
            form.button("§8« Back to Menu", "textures/ui/back_button_default.png");

            form.show(player).then((response) => {
                if (response.canceled) return;

                if (response.selection === markers.length) {
                    // Back button was pressed
                    this.showMarkerManagementMenu(player);
                    return;
                }

                const selectedMarker = markers[response.selection];
                this.confirmDeleteMarker(player, selectedMarker);
            }).catch((error) => {
                player.sendMessage("§c[BedrockMap] Failed to show delete menu: " + error.message);
            });

        } catch (error) {
            player.sendMessage(`§c[BedrockMap] Error loading markers: ${error.message}`);
        }
    }

    async fetchPlayerMarkers(playerName) {
        try {
            const request = new HttpRequest(`${API_BASE_URL}/markers/list`);
            request.method = HttpRequestMethod.Post;
            request.headers = [
                new HttpHeader('Content-Type', 'application/json'),
                new HttpHeader('X-API-Key', BEDROCKMAP_API_KEY)
            ];
            request.body = JSON.stringify({
                playerName: playerName
            });

            const response = await http.request(request);

            if (response.status === 200) {
                const data = JSON.parse(response.body);
                return data.markers || [];
            } else {
                this.log(`Failed to fetch markers: ${response.status}`, 'warn');
                return [];
            }
        } catch (error) {
            this.log(`Error fetching markers: ${error.toString()}`, 'error');
            return [];
        }
    }

    getMarkerTypeIcon(type) {
        const icons = {
            'home': '§e[HOME]',
            'shop': '§a[SHOP]',
            'farm': '§2[FARM]',
            'landmark': '§6[LANDMARK]'
        };
        return icons[type] || '§6[LANDMARK]';
    }

    confirmDeleteMarker(player, marker) {
        const dimDisplay = marker.dimension.replace('minecraft:', '');
        const form = new ActionFormData()
            .title("§cConfirm Deletion")
            .body(`§7Are you sure you want to delete this marker?\n\n§e${marker.text}\n§7Type: §f${marker.marker_type}\n§7Location: §f${marker.x}, ${marker.z}\n§7Dimension: §f${dimDisplay}\n\n§c⚠ This action cannot be undone!`)
            .button("§c[DELETE] Delete Marker", "textures/ui/realms_red_x.png")
            .button("§8[CANCEL] Cancel", "textures/ui/cancel.png");

        form.show(player).then((response) => {
            if (response.canceled || response.selection === 1) {
                this.showDeleteMarkerMenu(player);
                return;
            }

            if (response.selection === 0) {
                this.deleteMarker(player, marker);
            }
        }).catch((error) => {
            player.sendMessage("§c[BedrockMap] Failed to show confirmation: " + error.message);
        });
    }

    async deleteMarker(player, marker) {
        try {
            player.sendMessage("§e[BedrockMap] Deleting marker...");

            const request = new HttpRequest(`${API_BASE_URL}/markers/${marker.id}`);
            request.method = HttpRequestMethod.Delete;
            request.headers = [
                new HttpHeader('Content-Type', 'application/json'),
                new HttpHeader('X-API-Key', BEDROCKMAP_API_KEY)
            ];
            request.body = JSON.stringify({
                playerName: player.name
            });

            const response = await http.request(request);

            if (response.status === 200) {
                try {
                    const data = JSON.parse(response.body);
                    if (data.success) {
                        player.sendMessage(`§a[BedrockMap] Marker "${marker.text}" has been deleted successfully!`);
                        this.updateSlugFromResponse(data.worldSlug);
                        player.sendMessage(`§7View the updated map at: §b${this.getMapUrl()}`);
                    } else {
                        player.sendMessage(`§c[BedrockMap] Failed to delete marker: ${data.error || 'Unknown error'}`);
                    }
                } catch (parseError) {
                    player.sendMessage(`§a[BedrockMap] Marker deleted successfully!`);
                }
            } else if (response.status === 403) {
                try {
                    const errorData = JSON.parse(response.body);
                    player.sendMessage("§c[BedrockMap] " + errorData.error);
                } catch {
                    player.sendMessage("§c[BedrockMap] You don't have permission to delete this marker.");
                }
            } else {
                player.sendMessage("§c[BedrockMap] Server error: " + response.status);
            }
        } catch (error) {
            player.sendMessage(`§c[BedrockMap] Error deleting marker: ${error.message}`);
            this.log("Marker deletion error:", error);
        }
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    log(message, level = 'info') {
        if (!ENABLE_LOGGING) return;

        const timestamp = new Date().toISOString();
        const prefix = '[BedrockMap]';

        switch (level) {
            case 'error':
                console.error(`${timestamp} ${prefix} ERROR: ${message}`);
                break;
            case 'warn':
                console.warn(`${timestamp} ${prefix} WARN: ${message}`);
                break;
            default:
                console.log(`${timestamp} ${prefix} INFO: ${message}`);
        }
    }

    getStatus() {
        return {
            playerTrackingRunning: this.isPlayerTrackingRunning,
            playerCount: this.lastPlayerCount,
            worldSlug: this.currentWorldSlug,
            apiConfigured: BEDROCKMAP_API_KEY !== '2f8afa7507c4f4199460cd743b3091078cde10624776d541471bcf002d8bbe09'
        };
    }
}

// Initialize the addon
const bedrockMapAddon = new BedrockMapAddon();

// Register modern commands using system.beforeEvents.startup
try {
    system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
        const commandPrefix = "bedrockmap";

        // Register /bedrockmap:marker command (available to all players)
        customCommandRegistry.registerCommand(
            {
                name: `${commandPrefix}:marker`,
                description: "Add markers to your BedrockMap world",
                permissionLevel: CommandPermissionLevel.Any,
                cheatsRequired: false
            },
            (origin) => {
                const player = origin.sourceEntity;
                if (!player) return;

                system.run(() => {
                    bedrockMapAddon.showMarkerManagementMenu(player);
                });
            }
        );

        // Register /bedrockmap:tracking command (admin only - Game Directors)
        customCommandRegistry.registerCommand(
            {
                name: `${commandPrefix}:tracking`,
                description: "Manage player tracking (start/stop/status)",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                cheatsRequired: false,
                mandatoryParameters: [
                    { name: 'action', type: CustomCommandParamType.String }
                ]
            },
            (origin, action) => {
                const player = origin.sourceEntity;
                if (!player) return;

                system.run(() => {
                    const normalizedAction = action.toLowerCase();
                    let message;

                    switch (normalizedAction) {
                        case 'start':
                            bedrockMapAddon.startPlayerTracking();
                            message = '§a[BedrockMap] Player tracking started';
                            break;
                        case 'stop':
                            bedrockMapAddon.stopPlayerTracking();
                            message = '§c[BedrockMap] Player tracking stopped';
                            break;
                        case 'status':
                            const status = bedrockMapAddon.getStatus();
                            player.sendMessage(`§e[BedrockMap] Status:`);
                            player.sendMessage(`§7Tracking: ${status.playerTrackingRunning ? '§aYes' : '§cNo'}`);
                            player.sendMessage(`§7Players: §f${status.playerCount}`);
                            player.sendMessage(`§7World: §f${status.worldSlug}`);
                            player.sendMessage(`§7API: ${status.apiConfigured ? '§aConfigured' : '§cNot configured'}`);
                            return;
                        default:
                            message = '§c[BedrockMap] Usage: /bedrockmap:tracking <start|stop|status>';
                    }

                    player.sendMessage(message);
                });
            }
        );

        console.log('[BedrockMap] Commands registered successfully');
    });
} catch (error) {
    console.error('[BedrockMap] ERROR setting up commands:', error.toString());
}

// Auto-start player tracking after a short delay
try {
    system.runTimeout(() => {
        bedrockMapAddon.startPlayerTracking();
    }, 40); // 2 second delay (40 ticks)
} catch (error) {
    console.error('[BedrockMap] ERROR setting up auto-startup:', error.toString());
}

// Handle player join/leave events
try {
    world.afterEvents.playerJoin.subscribe((event) => {
        bedrockMapAddon.log(`Player ${event.playerName} joined the server`);

        // Show welcome message
        system.runTimeout(() => {
            const player = world.getAllPlayers().find(p => p.name === event.playerName);
            if (player) {
                player.sendMessage(`§a[BedrockMap] Welcome! Type §e/bedrockmap:marker §ato add markers to the map.`);
                player.sendMessage(`§7View the live map at: §b${bedrockMapAddon.getMapUrl()}`);
            }
        }, 60);
    });
} catch (error) {
    console.error('[BedrockMap] ERROR setting up playerJoin:', error.toString());
}

try {
    world.afterEvents.playerLeave.subscribe((event) => {
        bedrockMapAddon.log(`Player ${event.playerName} left the server`);
    });
} catch (error) {
    console.error('[BedrockMap] ERROR setting up playerLeave:', error.toString());
}

// Export for potential external use
export { bedrockMapAddon };

console.log('§7[§6BedrockMap§7] - [§3v1.0.0§7] - [§3Premium Addon§7] - [§aLoaded successfully!§7]');
console.log(`§7[§6BedrockMap§7] World: §b${bedrockMapAddon.currentWorldSlug}`);
console.log(`§7[§6BedrockMap§7] Commands: §e/bedrockmap:marker §7(add markers) | §e/bedrockmap:tracking §7(admin commands)`);
