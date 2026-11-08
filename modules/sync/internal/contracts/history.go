package contracts

// HistoryVideo contains only the stable identity and bounded display text of an
// online video. It deliberately excludes room state and provider responses.
type HistoryVideo struct {
	Kind         string `json:"kind"`
	BVID         string `json:"bvid"`
	CID          string `json:"cid"`
	Part         int64  `json:"part"`
	EpisodeID    string `json:"episodeId,omitempty"`
	Title        string `json:"title"`
	EpisodeTitle string `json:"episodeTitle"`
}

// DecodeHistoryVideo validates an exact personal-history record.
func DecodeHistoryVideo(data []byte) (HistoryVideo, error) {
	o, err := DecodeObject(data)
	if err != nil {
		return HistoryVideo{}, ErrInvalidInput
	}
	fields := []string{"kind", "bvid", "cid", "part", "title", "episodeTitle"}
	v := HistoryVideo{}
	if episode, exists := o["episodeId"]; exists {
		id, ok := episode.(string)
		if !ok || !episodePattern.MatchString(id) {
			return HistoryVideo{}, ErrInvalidInput
		}
		v.EpisodeID = id
		fields = append(fields, "episodeId")
	}
	kind, k := o["kind"].(string)
	bvid, b := o["bvid"].(string)
	cid, c := o["cid"].(string)
	part, p := integer(o["part"], 1, 10000)
	title, t := o["title"].(string)
	episodeTitle, e := o["episodeTitle"].(string)
	if !shape(o, fields...) || !k || kind != "bilibili" || !b || !bvidPattern.MatchString(bvid) || !c || !cidPattern.MatchString(cid) || !p || (v.EpisodeID != "" && part != 1) || !t || !boundedText(title, 160, 640) || !e || !boundedText(episodeTitle, 160, 640) {
		return HistoryVideo{}, ErrInvalidInput
	}
	v.Kind, v.BVID, v.CID, v.Part, v.Title, v.EpisodeTitle = kind, bvid, cid, part, title, episodeTitle
	return v, nil
}
