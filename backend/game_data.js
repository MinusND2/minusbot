const GERMAN_WORDS = [
    "Abbrechen", "Abbruch", "Abdeckung", "Abend", "Abendessen", "Abenteuer", "Abfall", "Ablehnen", "Absicht", "Absolvent",
    "Abstimmung", "Absturz", "Abteilung", "Abtretung", "Achtung", "Acre", "Ader", "Adler", "Affe", "Affäre",
    "Agenda", "Agent", "Agentur", "Ahnung", "Aids", "Akademie", "Aktion", "Aktivist", "Aktivität", "Albtraum",
    "Album", "Alkohol", "Allee", "Allianz", "Alltag", "Alpen", "Also", "Alten", "Alter", "Ampel",
    "Analyse", "Anbieter", "Anfang", "Anfrage", "Angebot", "Angeln", "Angriff", "Angst", "Anker",
    "Ankunft", "Anlage", "Anliegen", "Anmerkung", "Anmut", "Annahme", "Anordnung", "Anregung", "Anreiz", "Anruf",
    "Anteil", "Antrieb", "Antwort", "Antworten", "Anwalts", "Anweisung", "Anwendung", "Anwesen", "Anzeige", "Anzug",
    "Apfel", "Apotheke", "April", "Arbeit", "Arbeiten", "Arbeiter", "Armband", "Armee", "Armut", "Arsch",
    "Artikel", "Arzt", "Asche", "Aspekt", "Assistent", "Atem", "Athlet", "Atlas", "Atmosphäre", "Attacke",
    "Attitüde", "Attribut", "Auch", "Aufgabe", "Auflage", "Auflösung", "Aufsatz", "Aufsehen", "Aufzug", "Auge",
    "August", "Ausbildung", "Ausdruck", "Ausführung", "Ausgabe", "Ausgaben", "Ausmaß", "Ausnahme", "Ausrede", "Ausrüstung",
    "Aussicht", "Austausch", "Auswahl", "Auswertung", "Auto", "Autobahn", "Autor", "Außerdem", "Baby", "Bach",
    "Backofen", "Badewanne", "Bahnhof", "Ball", "Ballon", "Banane", "Band", "Bank", "Barriere", "Bart",
    "Base", "Baseball", "Basic", "Basis", "Basketball", "Batterie", "Bauch", "Bauer", "Bauernhof", "Baum",
    "Baustelle", "Becher", "Becken", "Bedeutung", "Beerdigung", "Befehl", "Befragter", "Begleitung", "Begriff", "Behandlung",
    "Behauptung", "Behörde", "Bein", "Beispiel", "Beitrag", "Beklagte", "Belastung", "Beliebt", "Belohnung", "Benehmen",
    "Benzin", "Beobachter", "Berater", "Berechnung", "Bereich", "Berg", "Bergwerk", "Beruf", "Besatzung", "Beschwerde",
    "Besen", "Besitz", "Besondere", "Beste", "Besteck", "Bestimmung", "Bestrafung", "Besuch", "Besucher", "Betonung",
    "Betrieb", "Betriebs", "Betrug", "Bett", "Beutel", "Bewegung", "Beweis", "Bewertung", "Bewohner", "Beziehung",
    "Bezirk", "Bibel", "Bibliothek", "Biege", "Biene", "Bier", "Bild", "Bildschirm", "Bildung", "Bindung",
    "Birne", "Bischof", "Blase", "Blatt", "Blau", "Bleistift", "Blick", "Blitz", "Block", "Blog",
    "Blume", "Bluse", "Blut", "Bock", "Boden", "Bogen", "Bohne", "Bombe", "Boom", "Boot",
    "Bord", "Bote", "Botschaft", "Boxer", "Brand", "Bratwurst", "Brauch", "Braun", "Braut", "Bremse",
    "Brief", "Brille", "Brot", "Bruder", "Brunnen", "Brust", "Brücke", "Buch", "Buchen", "Buchstabe",
    "Bucht", "Budget", "Busch", "Butter", "Bär", "Börse", "Bücherei", "Bühne", "Bündel", "Bürger",
    "Büro", "Bürste", "Campus", "Cent", "Center", "Champion", "Chance", "Chancen", "Charakter", "Chef",
    "Chinesisch", "Chip", "Christian", "Clever", "Clip", "Clown", "Coach", "Code", "Computer", "Couch",
    "Creme", "Dach", "Dame", "Dampf", "Dank", "Danke", "Darlehen", "Darm", "Darsteller", "Datei",
    "Daten", "Datenbank", "Datum", "Dauer", "Debatte", "Deck", "Decke", "Deckel", "Defensive", "Definition",
    "Defizit", "Degen", "Dekade", "Delfin", "Delikt", "Demokrat", "Demokratie", "Denken", "Denker", "Denkmal",
    "Dennoch", "Depression", "Designer", "Detail", "Detektiv", "Deutsch", "Deutung", "Dezember", "Diagnose", "Diagramm",
    "Dialog", "Diamant", "Dichter", "Dienen", "Diener", "Dienst", "Dienstag", "Dies", "Digital", "Dinosaurier",
    "Diplom", "Direkte", "Direktor", "Disko", "Diskurs", "Diskussion", "Disput", "Distanz", "Distel", "Disziplin",
    "Diversität", "Diät", "Doktor", "Dolch", "Dollar", "Dom", "Domain", "Donner", "Donnerstag", "Dorf",
    "Dorn", "Dose", "Drache", "Draht", "Drang", "Dreh", "Dreieck", "Druck", "Drücken", "Dschungel",
    "Duft", "Dumm", "Dummkopf", "Dunkelheit", "Dunst", "Durst", "Dusche", "Dutzend", "Düne", "Echo",
    "Ecke", "Edelstein", "Editor", "Efeu", "Effizienz", "Ehefrau", "Ehemann", "Ehren", "Eiche", "Eigentum",
    "Eigentümer", "Eile", "Eimer", "Einatz", "Einblick", "Eindruck", "Eingang", "Einheit", "Einkaufen", "Einkommen",
    "Einleitung", "Einmal", "Einnahmen", "Einschlag", "Eintrag", "Eintreten", "Eis", "Eisberg", "Eisen", "Elefant",
    "Element", "Elfenbein", "Elite", "Ellbogen", "Elster", "Elternteil", "Email", "Emission", "Emotion", "Empfang",
    "Empfehlung", "Empfänger", "Ende", "Energie", "Engagement", "Engel", "Englisch", "Enkel", "Entdeckung", "Ente",
    "Entität", "Entspannen", "Entwickler", "Entwurf", "Epoche", "Erbe", "Erdbeere", "Erde", "Erfahrung", "Erfolg",
    "Ergebnis", "Erholung", "Erinnerung", "Erkennung", "Erklärung", "Erkrankung", "Erlaubnis", "Ermittler", "Ernst", "Ernsthaft",
    "Ernte", "Error", "Erste", "Ertrag", "Erwachsene", "Erwartung", "Erwägen", "Erwägung", "Erzieher", "Erzähler",
    "Esel", "Essen", "Essig", "Esslöffel", "Etage", "Ethik", "Etikett", "Eule", "Evangelium", "Evolution",
    "Exekutive", "Existenz", "Experiment", "Experte", "Explosion", "Export", "Exposition", "Fabrik", "Fachmann", "Faden",
    "Fahrbahn", "Fahrkarte", "Fahrrad", "Fahrstuhl", "Fahrt", "Fahrzeug", "Faktor", "Fakultät", "Falke", "Fall",
    "Fallschirm", "Falsch", "Familie", "Fang", "Fantasie", "Farbe", "Fasan", "Faser", "Fass", "Faust",
    "Fazit", "Februar", "Feder", "Fehler", "Feier", "Feige", "Feind", "Felge", "Fels", "Felsen",
    "Fenster", "Ferien", "Fernglas", "Fernsehen", "Fernseher", "Fessel", "Fest", "Feste", "Festival", "Festnahme",
    "Fett", "Feuer", "Fichte", "Ficken", "Fieber", "Figur", "Fiktion", "Film", "Filter", "Finale",
    "Finanzen", "Finger", "Firma", "Fisch", "Flagge", "Flamme", "Flasche", "Fleisch", "Fliege", "Fliese",
    "Floh", "Floß", "Flucht", "Flug", "Flughafen", "Flugzeug", "Flur", "Fluss", "Flut", "Flöte",
    "Flüchtling", "Flügel", "Fokus", "Folge", "Folgen", "Folie", "Fonds", "Forelle", "Form", "Format",
    "Formation", "Formel", "Forscher", "Forschung", "Fortfahren", "Fortschritt", "Forum", "Foto", "Fotograf", "Fracht",
    "Frage", "Fragen", "Frau", "Freiheit", "Freitag", "Fremder", "Frequenz", "Freude", "Freund", "Friede",
    "Frieden", "Frosch", "Frost", "Frucht", "Fräulein", "Fröhlich", "Frühling", "Frühstück", "Fuchs", "Fund",
    "Funke", "Funktion", "Furcht", "Futter", "Fuß", "Fußball", "Fähigkeit", "Fähre", "Führer", "Führung",
    "Gabel", "Galaxis", "Galerie", "Gang", "Gans", "Garage", "Garantie", "Garten", "Gas", "Gast",
    "Gastgeber", "Gebet", "Gebiet", "Gebraucht", "Geburt", "Geburtstag", "Gebäude", "Gebühr", "Geck", "Gedicht",
    "Geduldig", "Gefahr", "Gefallen", "Gefängnis", "Gefühl", "Gegenstand", "Gegenteil", "Gegenwart", "Gegner", "Gehalt",
    "Geheimnis", "Gehirn", "Gehäuse", "Geist", "Gelb", "Geld", "Gelehrte", "Gemälde", "Gemüse", "Generation",
    "Genius", "Gentleman", "Gericht", "Geruch", "Gerät", "Gerücht", "Gesamt", "Geschenk", "Geschichte", "Geschlecht",
    "Geschmack", "Geschäft", "Geselle", "Gesetz", "Gesicht", "Gespräch", "Geste", "Getreide", "Getränk", "Gewalt",
    "Gewebe", "Gewehr", "Gewicht", "Gewinner", "Gewohnheit", "Gießen", "Gipfel", "Gitarre", "Glas", "Glauben",
    "Gletscher", "Globus", "Glocke", "Glück", "Glücklich", "Gold", "Golf", "Gondel", "Gott", "Gouverneur",
    "Grab", "Grad", "Graf", "Gras", "Gremium", "Grenze", "Grippe", "Großartig", "Großvater", "Grund",
    "Gruppe", "Grusel", "Größe", "Grün", "Gründen", "Gründer", "Gürtel", "Haar", "Hacke", "Hafen",
    "Hahn", "Haifisch", "Haken", "Halle", "Hallo", "Hals", "Hammer", "Hand", "Handel", "Handlung",
    "Handschuh", "Handtuch", "Handwerk", "Handy", "Hase", "Hass", "Haube", "Haufen", "Hauptstadt", "Haus",
    "Haushalt", "Haustier", "Haut", "Hecke", "Hefe", "Heft", "Heide", "Heimat", "Held", "Helm",
    "Hemd", "Hengst", "Herbst", "Herd", "Herr", "Hersteller", "Herz", "Hexe", "Hier", "Hilfe",
    "Himmel", "Hingabe", "Hinweis", "Hirsch", "Historiker", "Hitze", "Hobel", "Hochschule", "Hochzeit", "Hof",
    "Holz", "Honig", "Horizont", "Horn", "Hose", "Hotel", "Huhn", "Hummer", "Humor", "Hund",
    "Hurrikan", "Hut", "Hypothek", "Hypothese", "Häftling", "Händler", "Höhe", "Höhle", "Hölle", "Hören",
    "Hüfte", "Hügel", "Hündin", "Hütte", "Ideal", "Idee", "Identität", "Igel", "Ihnen", "Immigrant",
    "Impfung", "Index", "Industrie", "Infektion", "Inflation", "Inhalt", "Initial", "Initiative", "Innenstadt", "Innerhalb",
    "Innovation", "Insel", "Institut", "Instrument", "Integrität", "Interesse", "Internet", "Interview", "Investor", "Islam",
    "Jacke", "Jagd", "Jahr", "Jahreszeit", "Jammer", "Januar", "Jazz", "Journalist", "Jubiläum", "Jugend",
    "Juli", "Jung", "Junge", "Juni", "Junior", "Jury", "Juwel", "Jäger", "Kabel", "Kabine",
    "Kabinett", "Kaffee", "Kahn", "Kaiser", "Kakao", "Kaktus", "Kalb", "Kalorie", "Kamel", "Kamera",
    "Kamin", "Kamm", "Kammer", "Kampagne", "Kampf", "Kanal", "Kandidat", "Kaninchen", "Kanne", "Kante",
    "Kanu", "Kapazität", "Kapitel", "Kapitän", "Kappe", "Karosserie", "Karotte", "Karte", "Kartoffel", "Karton",
    "Kasse", "Kastanie", "Kasten", "Kategorie", "Kater", "Katze", "Kauf", "Kaufen", "Kegel", "Kehle",
    "Keks", "Kelch", "Keller", "Kerl", "Kessel", "Kette", "Kiefern", "Kind", "Kindheit", "Kinn",
    "Kirche", "Kirsche", "Kissen", "Kiste", "Klage", "Klang", "Klasse", "Klaue", "Klavier", "Klee",
    "Kleid", "Kleidung", "Kleinkind", "Klient", "Klima", "Klinik", "Klippe", "Klo", "Kloster", "Kluft",
    "Knie", "Knoblauch", "Knochen", "Knopf", "Knoten", "Koalition", "Koch", "Koffer", "Kohl", "Kohle",
    "Kollege", "Kollektiv", "Komfort", "Komitee", "Kommandant", "Kommen", "Kommentar", "Kommissar", "Kommission", "Kompass",
    "Komplett", "Komplex", "Komponente", "Komödie", "Kondition", "Konferenz", "Konflikt", "Kongress", "Konstante", "Kontakt",
    "Kontext", "Konto", "Kontrast", "Kontrolle", "Konvention", "Konzept", "Konzern", "Konzert", "Kopf", "Kopieren",
    "Korb", "Korken", "Korps", "Korrekt", "Korruption", "Kosmos", "Kosten", "Krabbe", "Kraft", "Kran",
    "Krankheit", "Kranz", "Kraut", "Kreatur", "Krebs", "Kredit", "Kreide", "Kreis", "Kreislauf", "Kreuz",
    "Krieg", "Krieger", "Krise", "Kriterien", "Kritik", "Kritiker", "Krokodil", "Krone", "Krug", "Krähe",
    "Kuchen", "Kugel", "Kuh", "Kultur", "Kumpel", "Kunde", "Kunst", "Kupfer", "Kurs", "Kurve",
    "Kuss", "Kutsche", "Käfer", "Kämpfer", "Käse", "Käufer", "König", "Königin", "Körper", "Küche",
    "Künstler", "Kürbis", "Küste", "Labor", "Lachen", "Lachs", "Laden", "Lage", "Lager", "Lamm",
    "Lampe", "Land", "Landschaft", "Landung", "Lassen", "Lastwagen", "Latein", "Laterne", "Laub", "Lauf",
    "Laufen", "Lawine", "Leben", "Lebensstil", "Lebenszeit", "Leder", "Legende", "Lehm", "Lehre", "Lehren",
    "Lehrer", "Lehrplan", "Leib", "Leiche", "Leine", "Leise", "Leistung", "Leiter", "Lektion", "Lerche",
    "Lernen", "Leser", "Letztere", "Leutnant", "Liberale", "Licht", "Liebe", "Liebhaber", "Liebling", "Lied",
    "Lieferung", "Liga", "Lilie", "Linderung", "Linie", "Linse", "Lippe", "Liste", "Literatur", "Live",
    "Lizenz", "Loch", "Logik", "Lohn", "Lokomotive", "Luft", "Lunge", "Lust", "Lächeln", "Länge",
    "Lärm", "Löffel", "Löschen", "Lösung", "Löwe", "Lücke", "Lüge", "Macht", "Magen", "Magie",
    "Mahlzeit", "Mainstream", "Mais", "Maler", "Mama", "Manager", "Mandat", "Mangel", "Mann", "Mantel",
    "Marder", "Marine", "Marke", "Marketing", "Markieren", "Markt", "Marmor", "Marsch", "Maschine", "Maske",
    "Masse", "Mast", "Material", "Mathematik", "Mauer", "Maus", "Medien", "Medikament", "Medizin", "Meer",
    "Mehl", "Meile", "Meinung", "Meise", "Meister", "Melone", "Menge", "Mensch", "Menschen", "Menschheit",
    "Merkmal", "Messe", "Messer", "Messung", "Metall", "Meter", "Methode", "Mexikaner", "Miete", "Milch",
    "Milliarde", "Million", "Minderheit", "Minimum", "Minister", "Minute", "Minze", "Mischung", "Missbrauch", "Mission",
    "Mist", "Mitglied", "Mitte", "Mittwoch", "Mode", "Modell", "Modus", "Mohn", "Moment", "Monat",
    "Mond", "Monitor", "Montag", "Montage", "Moos", "Mord", "Morgen", "Motivation", "Motor", "Mund",
    "Muschel", "Museum", "Musical", "Musik", "Musiker", "Muskel", "Muslim", "Muster", "Mutter", "Mythos",
    "Mädchen", "Mähne", "Möbel", "Möhre", "Mörder", "Mörtel", "Mücke", "Mühe", "Mühle", "Müll",
    "Münze", "Mütze", "Nachbar", "Nachmittag", "Nacht", "Nacken", "Nadel", "Nagel", "Nahrung", "Name",
    "Narrativ", "Nase", "Nation", "National", "Natur", "Nebel", "Negativ", "Nein", "Nerv", "Nest",
    "Netz", "Netzwerk", "Nieder", "Niere", "Noch", "Norden", "Norm", "Notfall", "Notiz", "Notwendig",
    "November", "Nudel", "Null", "Nummer", "Nuss", "Nutzen", "Nutzer", "Oase", "Oben", "Oberfläche",
    "Objekt", "Obst", "Ofen", "Offizier", "Ohr", "Oktober", "Oliven", "Onkel", "Oper", "Operation",
    "Operator", "Opfer", "Opposition", "Orange", "Orgel", "Original", "Ort", "Ozean", "Paar", "Pack",
    "Paket", "Palast", "Palette", "Palme", "Panel", "Panther", "Panzer", "Papagei", "Papier", "Paradies",
    "Park", "Parken", "Partikel", "Partner", "Party", "Pass", "Passage", "Passagier", "Patch", "Patent",
    "Patrone", "Pauke", "Pause", "Pech", "Peer", "Pelz", "Pendel", "Perle", "Person", "Personal",
    "Pfad", "Pfanne", "Pfau", "Pfeffer", "Pfeife", "Pfeil", "Pferd", "Pfirsich", "Pflanze", "Pflaume",
    "Pflege", "Pflicht", "Pflug", "Pfote", "Pfund", "Phase", "Phrase", "Physik", "Phänomen", "Pille",
    "Pilot", "Pilz", "Pinguin", "Pinsel", "Pirat", "Pistole", "Pizza", "Plakat", "Plan", "Planet",
    "Planung", "Plastik", "Platte", "Plattform", "Platz", "Plauderei", "Plus", "Plätzchen", "Poesie", "Pole",
    "Politik", "Politiker", "Polizei", "Polizist", "Pony", "Population", "Portal", "Portion", "Porträt", "Pose",
    "Position", "Post", "Potenzial", "Preis", "Presse", "Priester", "Prinz", "Prinzessin", "Prinzip", "Priorität",
    "Prisma", "Privileg", "Probe", "Problem", "Produkt", "Produktion", "Professor", "Profi", "Profil", "Programm",
    "Projekt", "Protein", "Protest", "Prozent", "Prozess", "Präferenz", "Präsident", "Prüfung", "Publikum", "Pullover",
    "Puls", "Pult", "Pulver", "Pumpe", "Punkt", "Puppe", "Pyramide", "Qualität", "Qualle", "Quark",
    "Quartal", "Quelle", "Querflöte", "Quittung", "Rabatt", "Rabe", "Rad", "Radikale", "Radio", "Rahmen",
    "Rain", "Rakete", "Rampe", "Rand", "Rang", "Rappe", "Rasen", "Ratschlag", "Ratte", "Rauch",
    "Raum", "Raupe", "Reaktion", "Real", "Rebe", "Rechen", "Rechner", "Rechnung", "Recht", "Rechts",
    "Rede", "Reform", "Regal", "Regel", "Regen", "Regierung", "Regime", "Region", "Reh", "Reich",
    "Reichtum", "Reifen", "Reihe", "Reim", "Reis", "Reise", "Reisen", "Reisepass", "Rekord", "Rektor",
    "Religion", "Rennbahn", "Rennen", "Rentner", "Reporter", "Republik", "Ressource", "Rest", "Restaurant", "Rettich",
    "Revolution", "Rezension", "Rezept", "Rezession", "Richter", "Richtlinie", "Richtung", "Riese", "Rind", "Ring",
    "Rinne", "Risiko", "Riss", "Ritter", "Robbe", "Roboter", "Rock", "Roggen", "Rohr", "Rolle",
    "Roman", "Rosa", "Rose", "Rosine", "Rost", "Route", "Routine", "Rucksack", "Ruder", "Ruf",
    "Ruhe", "Ruhestand", "Ruhm", "Rumpf", "Runde", "Russisch", "Rübe", "Rücken", "Rückkehr", "Rüstung",
    "Saal", "Saat", "Sache", "Sachen", "Sack", "Saft", "Sage", "Sake", "Salat", "Salz",
    "Samen", "Sammlung", "Samstag", "Sand", "Sandwich", "Sanft", "Sanktion", "Saphir", "Sarg", "Satellit",
    "Sattel", "Satz", "Sauce", "Sauerei", "Sauerstoff", "Schacht", "Schaden", "Schaf", "Schaffung", "Schal",
    "Schale", "Schalter", "Schande", "Scharf", "Schatten", "Schatz", "Schaufel", "Schaum", "Scheibe", "Schein",
    "Scheisse", "Scheitern", "Scheiße", "Schere", "Scherz", "Scheune", "Schicht", "Schicksal", "Schießen", "Schiff",
    "Schild", "Schildkröte", "Schinken", "Schirm", "Schlacht", "Schlaf", "Schlag", "Schlange", "Schlauch", "Schlecht",
    "Schleife", "Schloss", "Schlucht", "Schlüssel", "Schmalz", "Schmerz", "Schmerzen", "Schmuck", "Schmutz", "Schnabel",
    "Schnere", "Schnee", "Schneider", "Schnur", "Schock", "Schokolade", "Schrank", "Schraube", "Schrecken", "Schrei",
    "Schreiben", "Schrift", "Schritt", "Schuh", "Schuld", "Schule", "Schulter", "Schuppe", "Schuss", "Schutz",
    "Schwamm", "Schwan", "Schwanz", "Schwarz", "Schwein", "Schwert", "Schwester", "Schwimmbad", "Schwäche", "Schönheit",
    "Schüler", "Schüssel", "See", "Seele", "Segel", "Segment", "Seide", "Seife", "Seil", "Sein",
    "Seite", "Sekretär", "Sektion", "Sektor", "Sekunde", "Selbstmord", "Selten", "Semmel", "Senat", "Senator",
    "Senf", "Senior", "September", "Serie", "Server", "Service", "Sessel", "Seufzen", "Shake", "Sheriff",
    "Shirt", "Show", "Sicherheit", "Sicht", "Sieb", "Sieben", "Siedlung", "Sieg", "Siegel", "Signal",
    "Silber", "Single", "Sinn", "Sitz", "Sitzung", "Skala", "Skandal", "Sklave", "Skript", "Smaragd",
    "Socke", "Sofa", "Software", "Sohn", "Soldat", "Sommer", "Sonne", "Sonntag", "Sorge", "Sortieren",
    "Sozial", "Soße", "Spanisch", "Spannung", "Spaß", "Spezialist", "Spezies", "Spezifisch", "Spiegel", "Spiel",
    "Spieler", "Spielstart", "Spielzeug", "Spinat", "Spinne", "Spion", "Spitze", "Sport", "Sprache", "Sprecher",
    "Spur", "Stabilität", "Stadion", "Stadt", "Stahl", "Stall", "Stamm", "Stand", "Standard", "Star",
    "Start", "Startseite", "Status", "Staub", "Stehen", "Stein", "Stelle", "Stempel", "Stern", "Steuer",
    "Stiefel", "Stier", "Stift", "Stiftung", "Stil", "Stille", "Stimme", "Stimmung", "Stipendium", "Stirn",
    "Stock", "Stoff", "Stolz", "Storch", "Strafe", "Strahl", "Strahlung", "Strand", "Strategie", "Strauch",
    "Straße", "Streifen", "Streik", "Streit", "Strick", "Strom", "Struktur", "Strumpf", "Stube", "Student",
    "Studio", "Stuhl", "Stunde", "Sturm", "Stute", "Stärke", "Störung", "Stück", "Substanz", "Suche",
    "Super", "Suppe", "Symbol", "Symptom", "System", "Szenario", "Szene", "Sänger", "Säule", "Säure",
    "Sünde", "Süss", "Süssigkeit", "Süßigkeit", "Tabak", "Tabelle", "Tafel", "Tag", "Tagebuch", "Taktik",
    "Tal", "Talent", "Tanne", "Tante", "Tanz", "Tasche", "Tasse", "Tastatur", "Taste", "Tatsache",
    "Tau", "Taube", "Taucher", "Team", "Technik", "Techniker", "Teelöffel", "Teenager", "Teich", "Teig",
    "Teil", "Teilen", "Teilnehmer", "Teilt", "Teilung", "Telefon", "Teller", "Temperatur", "Tempo", "Tendenz",
    "Teppich", "Termin", "Terror", "Terrorist", "Teufel", "Text", "Theater", "Thema", "Theorie", "Therapie",
    "Thron", "Tiefe", "Tier", "Tierwelt", "Tiger", "Tinte", "Tisch", "Titel", "Tochter", "Tod",
    "Tomate", "Tonhöhe", "Topf", "Tor", "Torte", "Tour", "Tourist", "Tradition", "Tragödie", "Transfer",
    "Transport", "Traum", "Treffen", "Treiber", "Treibstoff", "Trend", "Treppe", "Tresor", "Tribüne", "Trichter",
    "Trick", "Trinkglas", "Triumph", "Trommel", "Trompete", "Tropfen", "Trost", "Trotz", "Truhe", "Trupp",
    "Träger", "Träne", "Tschüss", "Tulpe", "Tunnel", "Turm", "Turnier", "Täglich", "Tötung", "Tür",
    "Uhr", "Uhu", "Umfang", "Umfrage", "Umgebung", "Umstand", "Umwelt", "Unbekannt", "Unfall", "Uniform",
    "Union", "Universität", "Universum", "Unterhose", "Unterricht", "Unterseite", "Urban", "Urlaub", "Ursprung", "Urwald",
    "Variable", "Variation", "Vase", "Vater", "Vati", "Veilchen", "Ventil", "Verband", "Verbindung", "Verbot",
    "Verbrauch", "Verbrechen", "Verbündete", "Verdienste", "Verein", "Verfahren", "Verfassung", "Vergleich", "Vergnügen", "Verhalten",
    "Verhältnis", "Verhütung", "Verkauf", "Verkehr", "Verlag", "Verlangen", "Verlassen", "Verletzung", "Verlust", "Verordnung",
    "Versagen", "Verstehen", "Verstoß", "Versuch", "Versuchen", "Verteilung", "Vertrag", "Vertrauen", "Vertreter", "Verwaltung",
    "Verzeihung", "Veteran", "Vetter", "Video", "Viel", "Vielfalt", "Viertel", "Villa", "Virus", "Vision",
    "Vize", "Vogel", "Volk", "Volumen", "Vorfall", "Vorgehen", "Vorhang", "Vorhersage", "Vorschlag", "Vorsichtig",
    "Vorteil", "Vortrag", "Waage", "Wabe", "Wachs", "Wachstum", "Waffe", "Wagen", "Wahl", "Wahr",
    "Wahrheit", "Wald", "Walfisch", "Walnuss", "Walze", "Wand", "Wange", "Wappen", "Warnung", "Warteschlange",
    "Wartung", "Wasser", "Webseite", "Weide", "Weihnachten", "Wein", "Weise", "Weisheit", "Weizen", "Weiß",
    "Welle", "Welt", "Wenn", "Werbung", "Werdegang", "Werkstatt", "Werkzeug", "Wert", "Weste", "Westen",
    "Western", "Wettbewerb", "Wette", "Wetter", "Whoa", "Widerstand", "Wiese", "Wildnis", "Wille", "Wimper",
    "Wind", "Winkel", "Winter", "Wirbel", "Wirksam", "Wirkung", "Wirtschaft", "Wissen", "Wissenschaft", "Witz",
    "Woche", "Wochenende", "Wohlfahrt", "Wohnung", "Wolf", "Wolke", "Wolle", "Wort", "Wunde", "Wunder",
    "Wunsch", "Wurf", "Wurm", "Wurst", "Wurzel", "Wut", "Wählen", "Wähler", "Währung", "Wärme",
    "Wäsche", "Wüste", "Zahl", "Zahlen", "Zahlung", "Zahn", "Zange", "Zaun", "Zebra", "Zehe",
    "Zeichen", "Zeichnung", "Zeigefinger", "Zeit", "Zeitplan", "Zeitraum", "Zeitung", "Zelle", "Zelt", "Zement",
    "Zensur", "Zentimeter", "Zepter", "Zeremonie", "Zerstörung", "Zettel", "Zeuge", "Zeugnis", "Ziege", "Ziegel",
    "Ziel", "Zigarette", "Zigarre", "Zimmer", "Zimt", "Zink", "Zinn", "Zirkel", "Zirkus", "Zitrone",
    "Zoll", "Zone", "Zoo", "Zopf", "Zucker", "Zug", "Zugriff", "Zukunft", "Zulassung", "Zunahme",
    "Zunge", "Zusatz", "Zuschauer", "Zustand", "Zutat", "Zweck", "Zweifel", "Zweig", "Zwiebel", "Zwilling",
    "Zylinder", "Zähler", "Änderung", "Öffnung", "Ökonom", "Überleben", "Überlegen", "Übernehmen", "Übersetzen", "Übung"
];

const COUNTRIES = [
    { code: "de", name: "Deutschland" },
    { code: "fr", name: "Frankreich" },
    { code: "it", name: "Italien" },
    { code: "es", name: "Spanien" },
    { code: "pt", name: "Portugal" },
    { code: "nl", name: "Niederlande" },
    { code: "be", name: "Belgien" },
    { code: "at", name: "Österreich" },
    { code: "ch", name: "Schweiz" },
    { code: "dk", name: "Dänemark" },
    { code: "se", name: "Schweden" },
    { code: "no", name: "Norwegen" },
    { code: "fi", name: "Finnland" },
    { code: "pl", name: "Polen" },
    { code: "cz", name: "Tschechien" },
    { code: "sk", name: "Slowakei" },
    { code: "hu", name: "Ungarn" },
    { code: "hr", name: "Kroatien" },
    { code: "si", name: "Slowenien" },
    { code: "gr", name: "Griechenland" },
    { code: "tr", name: "Türkei" },
    { code: "ru", name: "Russland" },
    { code: "ua", name: "Ukraine" },
    { code: "ro", name: "Rumänien" },
    { code: "bg", name: "Bulgarien" },
    { code: "ie", name: "Irland" },
    { code: "is", name: "Island" },
    { code: "lu", name: "Luxemburg" },
    { code: "gb", name: "Großbritannien" },
    { code: "ca", name: "Kanada" },
    { code: "mx", name: "Mexiko" },
    { code: "br", name: "Brasilien" },
    { code: "ar", name: "Argentinien" },
    { code: "cl", name: "Chile" },
    { code: "co", name: "Kolumbien" },
    { code: "pe", name: "Peru" },
    { code: "ve", name: "Venezuela" },
    { code: "uy", name: "Uruguay" },
    { code: "bo", name: "Bolivien" },
    { code: "py", name: "Paraguay" },
    { code: "ec", name: "Ecuador" },
    { code: "cn", name: "China" },
    { code: "jp", name: "Japan" },
    { code: "kr", name: "Südkorea" },
    { code: "in", name: "Indien" },
    { code: "au", name: "Australien" },
    { code: "nz", name: "Neuseeland" },
    { code: "za", name: "Südafrika" },
    { code: "eg", name: "Ägypten" },
    { code: "ma", name: "Marokko" },
    { code: "dz", name: "Algerien" },
    { code: "tn", name: "Tunesien" },
    { code: "ly", name: "Libyen" },
    { code: "ke", name: "Kenia" },
    { code: "ng", name: "Nigeria" },
    { code: "gh", name: "Ghana" },
    { code: "sn", name: "Senegal" },
    { code: "cm", name: "Kamerun" },
    { code: "th", name: "Thailand" },
    { code: "vn", name: "Vietnam" },
    { code: "ph", name: "Philippinen" },
    { code: "id", name: "Indonesien" },
    { code: "my", name: "Malaysia" },
    { code: "sg", name: "Singapur" },
    { code: "pk", name: "Pakistan" },
    { code: "ir", name: "Iran" },
    { code: "iq", name: "Irak" },
    { code: "sa", name: "Saudi-Arabien" },
    { code: "ae", name: "Emirate" },
    { code: "il", name: "Israel" },
    { code: "jo", name: "Jordanien" },
    { code: "lb", name: "Libanon" },
    { code: "sy", name: "Syrien" },
    { code: "cu", name: "Kuba" },
    { code: "jm", name: "Jamaika" },
    { code: "pa", name: "Panama" },
    { code: "ee", name: "Estland" },
    { code: "lv", name: "Lettland" },
    { code: "lt", name: "Litauen" },
    { code: "by", name: "Belarus" },
    { code: "md", name: "Moldawien" },
    { code: "ge", name: "Georgien" },
    { code: "am", name: "Armenien" },
    { code: "az", name: "Aserbaidschan" },
    { code: "kz", name: "Kasachstan" },
    { code: "uz", name: "Usbekistan" },
    { code: "np", name: "Nepal" },
    { code: "bd", name: "Bangladesch" },
    { code: "mg", name: "Madagaskar" },
    { code: "zw", name: "Simbabwe" },
    { code: "qa", name: "Katar" },
    { code: "cy", name: "Zypern" },
    { code: "mt", name: "Malta" },
    { code: "cr", name: "Costa-Rica" },
    { code: "us", name: "Usa" }
];

const GERMAN_CITIES = [
    {
        "name": "Berlin",
        "coord": "J5",
        "alt": [
            "I4",
            "I5",
            "I6",
            "J4",
            "J6",
            "K4",
            "K5",
            "K6"
        ]
    },
    {
        "name": "Hamburg",
        "coord": "G4",
        "alt": [
            "F3",
            "F4",
            "F5",
            "G3",
            "G5",
            "H3",
            "H4",
            "H5"
        ]
    },
    {
        "name": "München",
        "coord": "I13",
        "alt": [
            "H12",
            "H13",
            "H14",
            "I12",
            "I14",
            "J12",
            "J13",
            "J14"
        ]
    },
    {
        "name": "Köln",
        "coord": "D8",
        "alt": [
            "C7",
            "C8",
            "C9",
            "D7",
            "D9",
            "E7",
            "E8",
            "E9"
        ]
    },
    {
        "name": "Frankfurt am Main",
        "coord": "F9",
        "alt": [
            "E8",
            "E9",
            "E10",
            "F8",
            "F10",
            "G8",
            "G9",
            "G10"
        ]
    },
    {
        "name": "Stuttgart",
        "coord": "F12",
        "alt": [
            "E11",
            "E12",
            "E13",
            "F11",
            "F13",
            "G11",
            "G12",
            "G13"
        ]
    },
    {
        "name": "Düsseldorf",
        "coord": "D8",
        "alt": [
            "C7",
            "C8",
            "C9",
            "D7",
            "D9",
            "E7",
            "E8",
            "E9"
        ]
    },
    {
        "name": "Dortmund",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Essen",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Leipzig",
        "coord": "I7",
        "alt": [
            "H6",
            "H7",
            "H8",
            "I6",
            "I8",
            "J6",
            "J7",
            "J8"
        ]
    },
    {
        "name": "Bremen",
        "coord": "F4",
        "alt": [
            "E3",
            "E4",
            "E5",
            "F3",
            "F5",
            "G3",
            "G4",
            "G5"
        ]
    },
    {
        "name": "Dresden",
        "coord": "K8",
        "alt": [
            "J7",
            "J8",
            "J9",
            "K7",
            "K9",
            "L7",
            "L8",
            "L9"
        ]
    },
    {
        "name": "Hannover",
        "coord": "G6",
        "alt": [
            "F5",
            "F6",
            "F7",
            "G5",
            "G7",
            "H5",
            "H6",
            "H7"
        ]
    },
    {
        "name": "Nürnberg",
        "coord": "H10",
        "alt": [
            "G9",
            "G10",
            "G11",
            "H9",
            "H11",
            "I9",
            "I10",
            "I11"
        ]
    },
    {
        "name": "Duisburg",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Bochum",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Wuppertal",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Bielefeld",
        "coord": "E6",
        "alt": [
            "D5",
            "D6",
            "D7",
            "E5",
            "E7",
            "F5",
            "F6",
            "F7"
        ]
    },
    {
        "name": "Bonn",
        "coord": "D8",
        "alt": [
            "C7",
            "C8",
            "C9",
            "D7",
            "D9",
            "E7",
            "E8",
            "E9"
        ]
    },
    {
        "name": "Münster",
        "coord": "E6",
        "alt": [
            "D5",
            "D6",
            "D7",
            "E5",
            "E7",
            "F5",
            "F6",
            "F7"
        ]
    },
    {
        "name": "Karlsruhe",
        "coord": "E11",
        "alt": [
            "D10",
            "D11",
            "D12",
            "E10",
            "E12",
            "F10",
            "F11",
            "F12"
        ]
    },
    {
        "name": "Mannheim",
        "coord": "E10",
        "alt": [
            "D9",
            "D10",
            "D11",
            "E9",
            "E11",
            "F9",
            "F10",
            "F11"
        ]
    },
    {
        "name": "Augsburg",
        "coord": "H12",
        "alt": [
            "G11",
            "G12",
            "G13",
            "H11",
            "H13",
            "I11",
            "I12",
            "I13"
        ]
    },
    {
        "name": "Wiesbaden",
        "coord": "E9",
        "alt": [
            "D8",
            "D9",
            "D10",
            "E8",
            "E10",
            "F8",
            "F9",
            "F10"
        ]
    },
    {
        "name": "Mönchengladbach",
        "coord": "C8",
        "alt": [
            "B7",
            "B8",
            "B9",
            "C7",
            "C9",
            "D7",
            "D8",
            "D9"
        ]
    },
    {
        "name": "Gelsenkirchen",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Aachen",
        "coord": "C8",
        "alt": [
            "B7",
            "B8",
            "B9",
            "C7",
            "C9",
            "D7",
            "D8",
            "D9"
        ]
    },
    {
        "name": "Braunschweig",
        "coord": "H6",
        "alt": [
            "G5",
            "G6",
            "G7",
            "H5",
            "H7",
            "I5",
            "I6",
            "I7"
        ]
    },
    {
        "name": "Chemnitz",
        "coord": "J8",
        "alt": [
            "I7",
            "I8",
            "I9",
            "J7",
            "J9",
            "K7",
            "K8",
            "K9"
        ]
    },
    {
        "name": "Kiel",
        "coord": "G2",
        "alt": [
            "F1",
            "F2",
            "F3",
            "G1",
            "G3",
            "H1",
            "H2",
            "H3"
        ]
    },
    {
        "name": "Halle (Saale)",
        "coord": "I7",
        "alt": [
            "H6",
            "H7",
            "H8",
            "I6",
            "I8",
            "J6",
            "J7",
            "J8"
        ]
    },
    {
        "name": "Magdeburg",
        "coord": "I6",
        "alt": [
            "H5",
            "H6",
            "H7",
            "I5",
            "I7",
            "J5",
            "J6",
            "J7"
        ]
    },
    {
        "name": "Freiburg",
        "coord": "E13",
        "alt": [
            "D12",
            "D13",
            "D14",
            "E12",
            "E14",
            "F12",
            "F13",
            "F14"
        ]
    },
    {
        "name": "Krefeld",
        "coord": "C7",
        "alt": [
            "B6",
            "B7",
            "B8",
            "C6",
            "C8",
            "D6",
            "D7",
            "D8"
        ]
    },
    {
        "name": "Mainz",
        "coord": "E10",
        "alt": [
            "D9",
            "D10",
            "D11",
            "E9",
            "E11",
            "F9",
            "F10",
            "F11"
        ]
    },
    {
        "name": "Lübeck",
        "coord": "H3",
        "alt": [
            "G2",
            "G3",
            "G4",
            "H2",
            "H4",
            "I2",
            "I3",
            "I4"
        ]
    },
    {
        "name": "Erfurt",
        "coord": "H8",
        "alt": [
            "G7",
            "G8",
            "G9",
            "H7",
            "H9",
            "I7",
            "I8",
            "I9"
        ]
    },
    {
        "name": "Oberhausen",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Rostock",
        "coord": "I3",
        "alt": [
            "H2",
            "H3",
            "H4",
            "I2",
            "I4",
            "J2",
            "J3",
            "J4"
        ]
    },
    {
        "name": "Kassel",
        "coord": "F7",
        "alt": [
            "E6",
            "E7",
            "E8",
            "F6",
            "F8",
            "G6",
            "G7",
            "G8"
        ]
    },
    {
        "name": "Hagen",
        "coord": "D7",
        "alt": [
            "C6",
            "C7",
            "C8",
            "D6",
            "D8",
            "E6",
            "E7",
            "E8"
        ]
    },
    {
        "name": "Potsdam",
        "coord": "J6",
        "alt": [
            "I5",
            "I6",
            "I7",
            "J5",
            "J7",
            "K5",
            "K6",
            "K7"
        ]
    },
    {
        "name": "Saarbrücken",
        "coord": "D11",
        "alt": [
            "C10",
            "C11",
            "C12",
            "D10",
            "D12",
            "E10",
            "E11",
            "E12"
        ]
    },
    {
        "name": "Hamm",
        "coord": "E7",
        "alt": [
            "D6",
            "D7",
            "D8",
            "E6",
            "E8",
            "F6",
            "F7",
            "F8"
        ]
    },
    {
        "name": "Ludwigshafen",
        "coord": "E10",
        "alt": [
            "D9",
            "D10",
            "D11",
            "E9",
            "E11",
            "F9",
            "F10",
            "F11"
        ]
    },
    {
        "name": "Oldenburg",
        "coord": "E4",
        "alt": [
            "D3",
            "D4",
            "D5",
            "E3",
            "E5",
            "F3",
            "F4",
            "F5"
        ]
    },
    {
        "name": "Osnabrück",
        "coord": "E6",
        "alt": [
            "D5",
            "D6",
            "D7",
            "E5",
            "E7",
            "F5",
            "F6",
            "F7"
        ]
    },
    {
        "name": "Leverkusen",
        "coord": "D8",
        "alt": [
            "C7",
            "C8",
            "C9",
            "D7",
            "D9",
            "E7",
            "E8",
            "E9"
        ]
    },
    {
        "name": "Heidelberg",
        "coord": "F11",
        "alt": [
            "E10",
            "E11",
            "E12",
            "F10",
            "F12",
            "G10",
            "G11",
            "G12"
        ]
    },
    {
        "name": "Darmstadt",
        "coord": "F10",
        "alt": [
            "E9",
            "E10",
            "E11",
            "F9",
            "F11",
            "G9",
            "G10",
            "G11"
        ]
    },
    {
        "name": "Solingen",
        "coord": "D8",
        "alt": [
            "C7",
            "C8",
            "C9",
            "D7",
            "D9",
            "E7",
            "E8",
            "E9"
        ]
    },
    {
        "name": "Regensburg",
        "coord": "I11",
        "alt": [
            "H10",
            "H11",
            "H12",
            "I10",
            "I12",
            "J10",
            "J11",
            "J12"
        ]
    },
    {
        "name": "Ingolstadt",
        "coord": "H12",
        "alt": [
            "G11",
            "G12",
            "G13",
            "H11",
            "H13",
            "I11",
            "I12",
            "I13"
        ]
    },
    {
        "name": "Würzburg",
        "coord": "G10",
        "alt": [
            "F9",
            "F10",
            "F11",
            "G9",
            "G11",
            "H9",
            "H10",
            "H11"
        ]
    },
    {
        "name": "Ulm",
        "coord": "G12",
        "alt": [
            "F11",
            "F12",
            "F13",
            "G11",
            "G13",
            "H11",
            "H12",
            "H13"
        ]
    },
    {
        "name": "Pforzheim",
        "coord": "F11",
        "alt": [
            "E10",
            "E11",
            "E12",
            "F10",
            "F12",
            "G10",
            "G11",
            "G12"
        ]
    },
    {
        "name": "Wolfsburg",
        "coord": "H6",
        "alt": [
            "G5",
            "G6",
            "G7",
            "H5",
            "H7",
            "I5",
            "I6",
            "I7"
        ]
    },
    {
        "name": "Göttingen",
        "coord": "G7",
        "alt": [
            "F6",
            "F7",
            "F8",
            "G6",
            "G8",
            "H6",
            "H7",
            "H8"
        ]
    },
    {
        "name": "Reutlingen",
        "coord": "F12",
        "alt": [
            "E11",
            "E12",
            "E13",
            "F11",
            "F13",
            "G11",
            "G12",
            "G13"
        ]
    },
    {
        "name": "Koblenz",
        "coord": "E9",
        "alt": [
            "D8",
            "D9",
            "D10",
            "E8",
            "E10",
            "F8",
            "F9",
            "F10"
        ]
    },
    {
        "name": "Bremerhaven",
        "coord": "F4",
        "alt": [
            "E3",
            "E4",
            "E5",
            "F3",
            "F5",
            "G3",
            "G4",
            "G5"
        ]
    },
    {
        "name": "Jena",
        "coord": "I8",
        "alt": [
            "H7",
            "H8",
            "H9",
            "I7",
            "I9",
            "J7",
            "J8",
            "J9"
        ]
    },
    {
        "name": "Erlangen",
        "coord": "H10",
        "alt": [
            "G9",
            "G10",
            "G11",
            "H9",
            "H11",
            "I9",
            "I10",
            "I11"
        ]
    },
    {
        "name": "Siegen",
        "coord": "E8",
        "alt": [
            "D7",
            "D8",
            "D9",
            "E7",
            "E9",
            "F7",
            "F8",
            "F9"
        ]
    },
    {
        "name": "Hildesheim",
        "coord": "G6",
        "alt": [
            "F5",
            "F6",
            "F7",
            "G5",
            "G7",
            "H5",
            "H6",
            "H7"
        ]
    },
    {
        "name": "Salzgitter",
        "coord": "G6",
        "alt": [
            "F5",
            "F6",
            "F7",
            "G5",
            "G7",
            "H5",
            "H6",
            "H7"
        ]
    },
    {
        "name": "Kaiserslautern",
        "coord": "E10",
        "alt": [
            "D9",
            "D10",
            "D11",
            "E9",
            "E11",
            "F9",
            "F10",
            "F11"
        ]
    },
    {
        "name": "Schwerin",
        "coord": "H4",
        "alt": [
            "G3",
            "G4",
            "G5",
            "H3",
            "H5",
            "I3",
            "I4",
            "I5"
        ]
    },
    {
        "name": "Gera",
        "coord": "I8",
        "alt": [
            "H7",
            "H8",
            "H9",
            "I7",
            "I9",
            "J7",
            "J8",
            "J9"
        ]
    },
    {
        "name": "Zwickau",
        "coord": "J8",
        "alt": [
            "I7",
            "I8",
            "I9",
            "J7",
            "J9",
            "K7",
            "K8",
            "K9"
        ]
    },
    {
        "name": "Tübingen",
        "coord": "F12",
        "alt": [
            "E11",
            "E12",
            "E13",
            "F11",
            "F13",
            "G11",
            "G12",
            "G13"
        ]
    },
    {
        "name": "Flensburg",
        "coord": "F2",
        "alt": [
            "E1",
            "E2",
            "E3",
            "F1",
            "F3",
            "G1",
            "G2",
            "G3"
        ]
    },
    {
        "name": "Konstanz",
        "coord": "F13",
        "alt": [
            "E12",
            "E13",
            "E14",
            "F12",
            "F14",
            "G12",
            "G13",
            "G14"
        ]
    },
    {
        "name": "Worms",
        "coord": "E10",
        "alt": [
            "D9",
            "D10",
            "D11",
            "E9",
            "E11",
            "F9",
            "F10",
            "F11"
        ]
    },
    {
        "name": "Bamberg",
        "coord": "H10",
        "alt": [
            "G9",
            "G10",
            "G11",
            "H9",
            "H11",
            "I9",
            "I10",
            "I11"
        ]
    },
    {
        "name": "Marburg",
        "coord": "F8",
        "alt": [
            "E7",
            "E8",
            "E9",
            "F7",
            "F9",
            "G7",
            "G8",
            "G9"
        ]
    },
    {
        "name": "Wilhelmshaven",
        "coord": "E4",
        "alt": [
            "D3",
            "D4",
            "D5",
            "E3",
            "E5",
            "F3",
            "F4",
            "F5"
        ]
    },
    {
        "name": "Landshut",
        "coord": "I12",
        "alt": [
            "H11",
            "H12",
            "H13",
            "I11",
            "I13",
            "J11",
            "J12",
            "J13"
        ]
    },
    {
        "name": "Bayreuth",
        "coord": "I10",
        "alt": [
            "H9",
            "H10",
            "H11",
            "I9",
            "I11",
            "J9",
            "J10",
            "J11"
        ]
    },
    {
        "name": "Fulda",
        "coord": "G9",
        "alt": [
            "F8",
            "F9",
            "F10",
            "G8",
            "G10",
            "H8",
            "H9",
            "H10"
        ]
    },
    {
        "name": "Kempten",
        "coord": "G13",
        "alt": [
            "F12",
            "F13",
            "F14",
            "G12",
            "G14",
            "H12",
            "H13",
            "H14"
        ]
    },
    {
        "name": "Cottbus",
        "coord": "K7",
        "alt": [
            "J6",
            "J7",
            "J8",
            "K6",
            "K8",
            "L6",
            "L7",
            "L8"
        ]
    },
    {
        "name": "Trier",
        "coord": "D10",
        "alt": [
            "C9",
            "C10",
            "C11",
            "D9",
            "D11",
            "E9",
            "E10",
            "E11"
        ]
    },
    {
        "name": "Passau",
        "coord": "K12",
        "alt": [
            "J11",
            "J12",
            "J13",
            "K11",
            "K13",
            "L11",
            "L12",
            "L13"
        ]
    },
    {
        "name": "Stralsund",
        "coord": "J2",
        "alt": [
            "I1",
            "I2",
            "I3",
            "J1",
            "J3",
            "K1",
            "K2",
            "K3"
        ]
    },
    {
        "name": "Görlitz",
        "coord": "L8",
        "alt": [
            "K7",
            "K8",
            "K9",
            "L7",
            "L9",
            "M7",
            "M8",
            "M9"
        ]
    },
    {
        "name": "Rosenheim",
        "coord": "I13",
        "alt": [
            "H12",
            "H13",
            "H14",
            "I12",
            "I14",
            "J12",
            "J13",
            "J14"
        ]
    },
    {
        "name": "Friedrichshafen",
        "coord": "F13",
        "alt": [
            "E12",
            "E13",
            "E14",
            "F12",
            "F14",
            "G12",
            "G13",
            "G14"
        ]
    },
    {
        "name": "Berchtesgaden",
        "coord": "J13",
        "alt": [
            "I12",
            "I13",
            "I14",
            "J12",
            "J14",
            "K12",
            "K13",
            "K14"
        ]
    }
];

module.exports = {
    GERMAN_WORDS,
    COUNTRIES,
    GERMAN_CITIES
};
